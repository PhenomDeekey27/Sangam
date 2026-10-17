"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PlaybackState } from "@/features/speech/types";
import type { PlaybackPayload } from "@/types/socket";
import { AudioPlayer, type PlayOutcome } from "@/features/playback/services/audio-player";
import {
  PlaybackQueue,
  type PlaybackItem,
} from "@/features/playback/services/playback-queue";

/** The playable surface the hook drives; injectable for tests. */
export interface PlaybackPlayer {
  play(item: PlaybackItem): Promise<PlayOutcome>;
  stop(): void;
  dispose(): void;
}

export interface PlaybackQueueOptions {
  readonly capacity?: number;
  /** Injectable player; defaults to a real browser `AudioPlayer`. */
  readonly createPlayer?: () => PlaybackPlayer;
  /** Report playback states to the room's shared `aria-live` region. */
  readonly onNotice?: (message: string | null) => void;
}

export interface PlaybackQueueHook {
  readonly state: PlaybackState;
  /** Accept one server delivery; drops duplicates and stale arrivals. */
  readonly enqueue: (payload: PlaybackPayload, audio: ArrayBuffer) => void;
  /** Manual stop: mute the active item and discard the whole queue. */
  readonly stop: () => void;
  /**
   * Remote interruption (Stage 7). `sequence` is the server's boundary: mute
   * the active item, discard queued audio for that turn or older, reject late
   * frames for it, and keep playing anything above it (new speech).
   */
  readonly interrupt: (sequence: number) => void;
  /**
   * Stop and forget all playback. Used when the listening context changes
   * (room change, disconnect, teardown) so no stale audio or watermark
   * survives into the next context.
   */
  readonly reset: () => void;
}

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
  // Read through a ref so the mount effect below keeps empty deps (the raw
  // prop would trip exhaustive-deps and re-create the player per render).
  const createPlayerRef = useRef(options.createPlayer);
  useEffect(() => {
    noticeRef.current = options.onNotice;
    createPlayerRef.current = options.createPlayer;
  });

  /**
   * Surface one state to the shared notice region. Passing `null` clears
   * whatever the queue previously reported.
   */
  const notice = useCallback(
    (message: string | null) => noticeRef.current?.(message),
    [],
  );

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
    try {
      let item = queueRef.current?.next() ?? null;
      while (item && !disposedRef.current) {
        setState({ status: "playing" });
        let outcome: PlayOutcome;
        try {
          const played = await playerRef.current?.play(item);
          outcome = played ?? "stopped";
        } catch {
          setState({
            status: "error",
            error: {
              code: "unknown",
              message:
                "Voice playback failed — the translated text is still on screen.",
            },
          });
          notice(
            "Couldn't play one translation aloud — its text is still on screen.",
          );
          outcome = "played"; // consume the broken item, keep going
        }
        if (outcome === "blocked") {
          // Park: the item stays queued; a user gesture re-drains.
          setState({ status: "blocked" });
          notice(
            "Voice playback needs one interaction — tap or press any key to hear translations.",
          );
          return;
        }
        if (outcome === "stopped") {
          const reason = stopReasonRef.current;
          stopReasonRef.current = null;
          if (reason !== "manual") {
            // Interruption or reset: the caller already dropped the stale
            // items, so keep whatever newer speech is still queued and keep
            // the caller's notice intact.
            keepNotice = true;
            item = queueRef.current?.next() ?? null;
            continue;
          }
          queueRef.current?.clear();
          setState({ status: "stopped" });
          notice(null);
          return;
        }
        playedAny = true;
        // A non-stop outcome means any earlier stop reason is spent.
        stopReasonRef.current = null;
        queueRef.current?.markPlayed(item);
        item = queueRef.current?.next() ?? null;
      }
      if (!disposedRef.current) {
        setState({ status: "idle" });
        if (playedAny && !keepNotice) notice(null);
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

  const enqueue = useCallback(
    (payload: PlaybackPayload, audio: ArrayBuffer) => {
      if (disposedRef.current) return;
      queueRef.current?.enqueue({
        utteranceId: payload.utteranceId,
        sequence: payload.sequence,
        language: payload.language,
        mimeType: payload.mimeType,
        audio,
      });
      scheduleDrain();
    },
    [scheduleDrain],
  );

  const stop = useCallback(() => {
    stopReasonRef.current = "manual";
    playerRef.current?.stop();
  }, []);

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
  useEffect(() => {
    if (state.status !== "blocked") return;
    const unlock = () => {
      setState({ status: "idle" });
      void drain();
    };
    document.addEventListener("pointerdown", unlock, { once: true });
    document.addEventListener("keydown", unlock, { once: true });
    return () => {
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
  }, [state.status, drain]);

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

  return { state, enqueue, stop, interrupt, reset } as const;
}
