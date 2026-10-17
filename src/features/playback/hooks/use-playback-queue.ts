"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PlaybackState } from "@/features/speech/types";
import type { PlaybackPayload } from "@/types/socket";
import type { LanguageCode } from "@/types";
import {
  AudioPlayer,
  type PlayOutcome,
} from "@/features/playback/services/audio-player";
import { PlaybackQueue } from "@/features/playback/services/playback-queue";
import {
  describePlaybackError,
  logPlaybackDiagnostic,
} from "@/features/playback/utils/playback-diagnostics";
import type {
  NowPlaying,
  PlaybackPlayer,
  PlaybackQueueHook,
  PlaybackQueueOptions,
} from "./playback-queue-types";

// The queue's public surface stays importable from the hook itself.
export type {
  NowPlaying,
  PlaybackPlayer,
  PlaybackQueueHook,
  PlaybackQueueOptions,
};

/** Notice shown while the browser's autoplay policy holds playback parked. */
const BLOCKED_NOTICE =
  "Voice playback needs one interaction — tap or press any key to hear translations.";
/**
 * Notice shown after one item failed to play. It stays on screen until the next
 * delivery or an explicit retry, so a silent failure is never mistaken for
 * silence that the user asked for.
 */
const FAILURE_NOTICE =
  "Couldn't play one translation aloud — its text is still on screen.";

/**
 * Drives translated-speech playback for one room seat (Stage 6):
 *
 * - plays queued audio strictly in the server's `sequence` order and never
 *   repeats an utterance id (duplicate frames, history replays, and
 *   reconnect replays are all discarded by `PlaybackQueue`),
 * - reports a clear `PlaybackState`; on autoplay-policy refusal it parks in
 *   `blocked` and resumes on the first pointer/key gesture,
 * - isolates one broken item: it is skipped (its translated text stays in
 *   the transcript) and playback continues with the next,
 * - handles Stage 7 interruption: `interrupt(boundary)` mutes the active item
 *   and drops the interrupted turn without wiping new speech, while `reset()`
 *   stops and forgets everything for a disconnect or room change.
 */
export function usePlaybackQueue(
  options: PlaybackQueueOptions = {},
): PlaybackQueueHook {
  const [state, setState] = useState<PlaybackState>({ status: "idle" });
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null);
  const queueRef = useRef<PlaybackQueue | null>(null);
  if (queueRef.current === null) {
    queueRef.current = new PlaybackQueue({ capacity: options.capacity });
  }
  const playerRef = useRef<PlaybackPlayer | null>(null);
  const busyRef = useRef(false);
  // Why the active `play` was cut short. A drain that resumes from a
  // `"stopped"` outcome reads and clears this: `manual` drains the queue and
  // reports `stopped`; `interrupt`/`reset` keep going, because their stale
  // items were already removed by the caller.
  const stopReasonRef = useRef<"manual" | "interrupt" | "reset" | null>(null);
  const drainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Late kick-start: the drain loop re-picks a leftover through this ref so
  // `drain` itself never has to reference itself mid-declaration.
  const drainRef = useRef<() => void>(() => {});
  const disposedRef = useRef(false);
  const noticeRef = useRef(options.onNotice);
  // The message this hook last pushed to the notice region. A parked or failed
  // session is cleared by name, so an unrelated notice (an interruption, a join)
  // is never retracted by a playback retry.
  const lastNoticeRef = useRef<string | null>(null);
  // Read through a ref so the mount effect below keeps empty deps (the raw
  // prop would trip exhaustive-deps and re-create the player per render).
  const createPlayerRef = useRef(options.createPlayer);
  const onPlaybackStartRef = useRef(options.onPlaybackStart);
  useEffect(() => {
    noticeRef.current = options.onNotice;
    createPlayerRef.current = options.createPlayer;
    onPlaybackStartRef.current = options.onPlaybackStart;
  });

  /**
   * Surface one state to the shared notice region. Passing `null` clears
   * whatever the queue previously reported. The last message is remembered so
   * a retry can retract exactly its own notice and nothing newer.
   */
  const notice = useCallback((message: string | null) => {
    lastNoticeRef.current = message;
    noticeRef.current?.(message);
  }, []);

  const drain = useCallback(async (): Promise<void> => {
    // One loop at a time: re-entry only happens after the running loop has
    // released `busyRef`, and a leftover item re-schedules itself below.
    if (busyRef.current || disposedRef.current) return;
    busyRef.current = true;
    // Whether this run actually played something, and whether the caller told
    // us to stop mid-run (interrupt/reset) and set its own notice. Both decide
    // whether finishing may clear the shared notice.
    let playedAny = false;
    let keepNotice = false;
    // Whether the *last* item played failed. Decides whether finishing may
    // overwrite the visible failure with `idle` and clear its notice.
    let failedLast = false;
    try {
      let item = queueRef.current?.next() ?? null;
      while (item && !disposedRef.current) {
        setState({ status: "playing" });
        setNowPlaying({
          utteranceId: item.utteranceId,
          sequence: item.sequence,
          language: item.language as LanguageCode,
        });
        const activeItem = item;
        let outcome: PlayOutcome;
        let failed = false;
        try {
          // One-shot: the player calls this at the true start, and only then.
          let started = false;
          const markStarted = () => {
            if (started) return;
            started = true;
            logPlaybackDiagnostic({
              stage: "start",
              utteranceId: activeItem.utteranceId,
              sequence: activeItem.sequence,
              bytes: activeItem.audio.byteLength,
              mimeType: activeItem.mimeType,
              status: "playing",
            });
            onPlaybackStartRef.current?.(
              activeItem.utteranceId,
              activeItem.sequence,
            );
          };
          const played = await playerRef.current?.play(activeItem, markStarted);
          outcome = played ?? "stopped";
        } catch (error) {
          failed = true;
          // Never swallow the real reason: a genuine `play()` rejection is
          // reported (name + bounded message) so "no audio, no error" cannot
          // hide a broken element or codec.
          const failure = describePlaybackError(error);
          logPlaybackDiagnostic({
            stage: "failure",
            utteranceId: activeItem.utteranceId,
            sequence: activeItem.sequence,
            bytes: activeItem.audio.byteLength,
            mimeType: activeItem.mimeType,
            status: "error",
            reason: "play_rejected",
            errorName: failure.name,
            errorMessage: failure.message,
          });
          setState({
            status: "error",
            error: {
              code: "unknown",
              message:
                "Voice playback failed — the translated text is still on screen.",
            },
          });
          notice(FAILURE_NOTICE);
          setNowPlaying(null);
          outcome = "played"; // consume the broken item, keep going
        }
        if (!failed) {
          logPlaybackDiagnostic({
            stage: "outcome",
            utteranceId: activeItem.utteranceId,
            sequence: activeItem.sequence,
            status: outcome,
            reason:
              outcome === "stopped"
                ? (stopReasonRef.current ?? "stopped")
                : "settled",
          });
        }
        if (outcome === "blocked") {
          // Park: the item stays queued; a user gesture re-drains.
          setState({ status: "blocked" });
          setNowPlaying(null);
          notice(BLOCKED_NOTICE);
          return;
        }
        if (outcome === "stopped") {
          const reason = stopReasonRef.current;
          stopReasonRef.current = null;
          if (reason === null) {
            // Nobody asked for a stop yet one arrived (a disposed or replaced
            // player). Consume the item: re-picking it would spin the drain
            // forever on an item nothing will ever finish.
            queueRef.current?.markPlayed(item);
            setNowPlaying(null);
            item = queueRef.current?.next() ?? null;
            continue;
          }
          if (reason !== "manual") {
            // Interruption or reset: the caller already dropped the stale
            // items, so keep whatever newer speech is still queued and keep
            // the caller's notice intact.
            setNowPlaying(null);
            keepNotice = true;
            item = queueRef.current?.next() ?? null;
            continue;
          }
          queueRef.current?.clear();
          setState({ status: "stopped" });
          setNowPlaying(null);
          notice(null);
          return;
        }
        // A failed item still advances the watermark, but it never counts as
        // something the listener heard.
        playedAny = playedAny || !failed;
        // A non-stop outcome means any earlier stop reason is spent.
        stopReasonRef.current = null;
        queueRef.current?.markPlayed(item);
        // The item finished; clear before the next one (if any) claims the
        // "now playing" slot so the source/listener labels never go stale.
        setNowPlaying(null);
        failedLast = failed;
        item = queueRef.current?.next() ?? null;
      }
      if (!disposedRef.current && queueRef.current) {
        logPlaybackDiagnostic({
          stage: "state",
          status: failedLast ? "error" : "idle",
          reason: failedLast ? "last_item_rejected" : "drained",
        });
      }
      if (!disposedRef.current) {
        setNowPlaying(null);
        // A failed *last* item keeps its error state and notice visible; any
        // success after it (or a user stop) clears them through the loop.
        if (!failedLast) {
          setState({ status: "idle" });
          if (playedAny && !keepNotice) notice(null);
        }
      }
    } finally {
      busyRef.current = false;
    }
    // An item can slip in between the final `next()` check and the return:
    // pick the drain back up without blocking the caller.
    if (!disposedRef.current && queueRef.current && queueRef.current.size > 0) {
      drainRef.current();
    }
  }, [notice]);

  useEffect(() => {
    drainRef.current = () => {
      void drain();
    };
  }, [drain]);

  const scheduleDrain = useCallback(() => {
    // One macrotask of delay batches arrivals that land in the same tick, so
    // two frames delivered back-to-back still sort by `sequence` before the
    // first `play()` starts. A running loop re-picks leftovers itself.
    if (drainTimerRef.current !== null) return;
    drainTimerRef.current = setTimeout(() => {
      drainTimerRef.current = null;
      void drain();
    }, 0);
  }, [drain]);

  /**
   * Retract this hook's own parked/failed notice and leave that status. A
   * newer notice (an interruption, a join) is left untouched.
   */
  const leaveStalled = useCallback(() => {
    const stalled = lastNoticeRef.current;
    if (stalled === BLOCKED_NOTICE || stalled === FAILURE_NOTICE) notice(null);
    setState((current) =>
      current.status === "blocked" || current.status === "error"
        ? { status: "idle" }
        : current,
    );
  }, [notice]);

  const enqueue = useCallback(
    (payload: PlaybackPayload, audio: ArrayBuffer) => {
      if (disposedRef.current) return;
      const accepted =
        queueRef.current?.enqueue({
          utteranceId: payload.utteranceId,
          sequence: payload.sequence,
          language: payload.language,
          mimeType: payload.mimeType,
          audio,
        }) ?? false;
      logPlaybackDiagnostic({
        stage: accepted ? "intake" : "queue_discard",
        utteranceId: payload.utteranceId,
        sequence: payload.sequence,
        bytes: audio.byteLength,
        mimeType: payload.mimeType,
        status: accepted ? "queued" : "discarded",
        reason: accepted ? "queued" : "stale_duplicate_or_overflow",
      });
      // A fresh delivery is a new turn: it retires the previous failure so one
      // broken item can never leave the surface latched in `error` while later
      // audio is still waiting to be heard.
      if (accepted) leaveStalled();
      scheduleDrain();
    },
    [leaveStalled, scheduleDrain],
  );

  const stop = useCallback(() => {
    stopReasonRef.current = "manual";
    playerRef.current?.stop();
  }, []);

  /**
   * Resume from a user gesture. The browser only accepts `play()` inside the
   * gesture's own task, which is why this calls `drain` directly instead of
   * going through `scheduleDrain`'s timer.
   */
  const unlock = useCallback(() => {
    if (disposedRef.current) return;
    leaveStalled();
    void drain();
  }, [drain, leaveStalled]);

  const interrupt = useCallback(
    (sequence: number) => {
      if (disposedRef.current) return;
      queueRef.current?.interrupt(sequence);
      stopReasonRef.current = "interrupt";
      // Mute the active turn first; the drain that was awaiting it resumes
      // through the `"stopped"` branch and picks up any surviving new speech.
      playerRef.current?.stop();
      if (queueRef.current && queueRef.current.size > 0) scheduleDrain();
    },
    [scheduleDrain],
  );

  const reset = useCallback(() => {
    if (disposedRef.current) return;
    queueRef.current?.reset();
    stopReasonRef.current = "reset";
    playerRef.current?.stop();
  }, []);

  // A parked session resumes as soon as the user interacts with the page:
  // most browsers gate audio behind one user gesture ("sticky activation").
  // Any interaction counts, so the same `unlock` the control button calls is
  // wired here: the UI and this listener can never disagree about resuming.
  useEffect(() => {
    if (state.status !== "blocked") return;
    document.addEventListener("pointerdown", unlock, { once: true });
    document.addEventListener("keydown", unlock, { once: true });
    return () => {
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
  }, [state.status, unlock]);

  // The player and the disposed flag live inside the mount effect lifecycle:
  // React Strict Mode (mount → cleanup → mount) re-arms them on remount, so a
  // disposed player is never carried across a remount.
  useEffect(() => {
    disposedRef.current = false;
    playerRef.current = createPlayerRef.current?.() ?? new AudioPlayer();
    return () => {
      disposedRef.current = true;
      if (drainTimerRef.current !== null) {
        clearTimeout(drainTimerRef.current);
        drainTimerRef.current = null;
      }
      playerRef.current?.dispose();
      playerRef.current = null;
    };
  }, []);

  return {
    state,
    nowPlaying,
    enqueue,
    stop,
    unlock,
    interrupt,
    reset,
  } as const;
}
