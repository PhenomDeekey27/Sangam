"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  InterimUtterance,
  SpeakerState,
  TranscriptEntry,
} from "@/features/conversation/types";
import { useRoomSocket } from "@/features/room/hooks/use-room-socket";
import { getRoomSocket } from "@/features/room/services/socket";
import type {
  ConnectionStatus,
  ParticipantProfile,
  RoomMode,
  SpeakerSide,
} from "@/features/room/types";
import {
  toActiveSpeaker,
  toBroken,
  toFlow,
  toSpeakerStates,
} from "@/features/room/utils/derive";
import type { ActivePlayback } from "@/features/room/utils/identity";
import {
  isInterruptPending,
  type InterruptState,
} from "@/features/room/utils/interrupt-state";
import { useSpeechCapture } from "@/features/speech/hooks/use-speech-capture";
import { usePlaybackQueue } from "@/features/playback/hooks/use-playback-queue";
import { useSpeechSynthesisFallback } from "@/features/playback/hooks/use-speech-synthesis-fallback";
import { recordPlaybackStart } from "@/features/conversation/utils/latency";
import type {
  MicPermission,
  PlaybackState,
  RecognitionStatus,
  SpeechError,
  SpeechSupport,
  SpeechTransport,
} from "@/features/speech/types";
import type { LanguagePreferences } from "@/features/room/utils/language-preference";
import type { SocketError } from "@/types/socket";

export interface RoomConversationOptions {
  readonly code: string;
  readonly mode: RoomMode;
  /**
   * This participant's validated preferences: `speaking` drives their own
   * recognition locale, `listening` is what the room should translate into
   * for them (a later stage). Both are sent with every join so they survive
   * reconnects.
   */
  readonly preferences: LanguagePreferences;
}

/** State and actions the room UI needs. */
export interface RoomConversation {
  readonly connection: ConnectionStatus;
  /** Fatal membership failure (unknown room, full room) for the error banner. */
  readonly roomError: SocketError | null;
  readonly mic: MicPermission;
  /** Browser speech-recognition availability for the mic button and banner. */
  readonly speechSupport: SpeechSupport;
  /** Which pipeline the microphone will use (server, browser, or none). */
  readonly speechTransport: SpeechTransport;
  readonly recognitionStatus: RecognitionStatus;
  /** Non-null after a fatal capture failure (denied, no mic, …). */
  readonly recognitionError: SpeechError | null;
  readonly you: ParticipantProfile | null;
  readonly partner: ParticipantProfile | null;
  readonly speakerStates: Record<SpeakerSide, SpeakerState>;
  readonly capturing: boolean;
  readonly playback: PlaybackState;
  /** The translated-audio turn playing now, attributed to its source seat. */
  readonly nowPlaying: ActivePlayback | null;
  /** Interrupt is meaningful only with a seated partner and a live socket. */
  readonly canInterrupt: boolean;
  /** Requester-side interruption progress for the control's label/state. */
  readonly interruptState: InterruptState;
  readonly entries: readonly TranscriptEntry[];
  /** Live, replaceable interim lines per side for the transcript. */
  readonly interims: Readonly<Partial<Record<SpeakerSide, InterimUtterance>>>;
  readonly notice: string | null;
  readonly activeSpeaker: SpeakerSide | null;
  readonly flow: "none" | "a-to-b" | "b-to-a";
  readonly bridgeLabel: string | null;
  readonly broken: boolean;
  readonly canSendText: boolean;
  readonly toggleCapture: () => void;
  readonly sendText: (text: string) => void;
  readonly interrupt: () => void;
  /**
   * The single playback control's action: stop whatever is audible, and
   * otherwise resume/prime playback from the user's own click. It is never
   * inert — an idle, parked, or failed queue still answers it.
   */
  readonly togglePlayback: () => void;
  readonly retryConnection: () => void;
}

/**
 * Composes the room's socket connection with live microphone capture. The
 * socket half owns membership, transcript relay, and partner interims; the
 * speech half owns the Web Speech API lifecycle. Recognition stops whenever
 * the connection goes away, and identity always comes from server acks.
 */
export function useRoomConversation({
  code,
  mode,
  preferences,
}: RoomConversationOptions): RoomConversation {
  const { speaking, listening } = preferences;
  const [notice, setNotice] = useState<string | null>(null);
  const notify = useCallback(
    (message: string | null) => setNotice(message),
    [],
  );
  const captureStopRef = useRef<() => void>(() => {});
  const setCaptureStop = useCallback((stop: () => void) => {
    captureStopRef.current = stop;
  }, []);

  // Translated-speech playback (Stage 6): the server synthesizes each
  // completed translation for this listener; the queue plays in message
  // order, and `stop` is ready for Stage-7 cancellation.
  const playbackQueue = usePlaybackQueue({
    onNotice: notify,
    onPlaybackStart: recordPlaybackStart,
  });
  // The stable sinks go straight to the socket subscription: enqueue for new
  // deliveries, interrupt for a remote interruption's boundary, reset for a
  // disconnect/leave so the next room starts clean.
  const {
    enqueue: onPlayback,
    interrupt: queueInterrupt,
    reset: queueReset,
    stop: stopPlayback,
    unlock: unlockPlayback,
  } = playbackQueue;

  // Browser speech fallback: when the server cannot synthesize (no provider,
  // an unsupported language, or a provider outage) the translated text is
  // spoken locally instead of waiting for audio that will never arrive. The
  // transcript rows are read through a ref, so its ordering watermark survives
  // every re-render.
  const entriesRef = useRef<readonly TranscriptEntry[]>([]);
  const speechFallback = useSpeechSynthesisFallback({
    getText: (utteranceId) => {
      const row = entriesRef.current.find(
        (entry) => entry.utterance.id === utteranceId,
      );
      if (!row || row.translation.status !== "complete") return null;
      return row.translation.text;
    },
  });
  const { speak: speakFallback, interrupt: interruptFallback, reset: resetFallback } =
    speechFallback;
  // Interruption and teardown must silence both the server-audio queue and the
  // local fallback, so no line from the interrupted turn keeps speaking.
  const onPlaybackInterrupt = useCallback(
    (sequence: number) => {
      queueInterrupt(sequence);
      interruptFallback(sequence);
    },
    [queueInterrupt, interruptFallback],
  );
  const onPlaybackReset = useCallback(() => {
    queueReset();
    resetFallback();
  }, [queueReset, resetFallback]);

  // One control, two jobs. Stopping is only meaningful while something is
  // audible; every other status — idle and empty, parked by the autoplay
  // policy, or latched after a failed item — resolves to unlocking, which is
  // also the click a browser needs before it will start audio at all.
  const togglePlayback = useCallback(() => {
    if (playbackQueue.state.status === "playing") stopPlayback();
    else unlockPlayback();
  }, [playbackQueue.state.status, stopPlayback, unlockPlayback]);

  const {
    connection,
    roomError,
    seats,
    entries,
    partnerInterim,
    youState,
    partnerState,
    interruptState,
    retryConnection,
    sendUtterance,
    emitInterim,
    interrupt,
  } = useRoomSocket({
    code,
    mode,
    language: speaking,
    listeningLanguage: listening,
    notify,
    onSilence: () => captureStopRef.current(),
    onPlayback,
    onPlaybackInterrupt,
    onPlaybackReset,
    onPlaybackUnavailable: speakFallback,
  });

  // The fallback reads the latest transcript rows (a completed translation may
  // arrive after the "unavailable" frame, in which case its text is read then).
  // Mirrored in an effect, never during render.
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  // Translated-speech playback (Stage 6) is wired above the socket hook.

  const sendRecognized = useCallback(
    (text: string) => sendUtterance(text, "speech"),
    [sendUtterance],
  );

  // Recognition always follows *this* participant's speaking language, which
  // is what both the URL and the server record for their seat. When the server
  // advertises a streaming provider, audio is streamed there instead — the same
  // callbacks arrive through room events either way.
  const capture = useSpeechCapture({
    language: speaking,
    onFinalText: sendRecognized,
    onInterimEmit: emitInterim,
    onNotice: notify,
    getSocket: getRoomSocket,
  });

  useEffect(() => {
    setCaptureStop(capture.stop);
  }, [capture.stop, setCaptureStop]);

  const sendText = useCallback(
    (text: string) => sendUtterance(text, "typed"),
    [sendUtterance],
  );

  const toggleCapture = useCallback(() => {
    if (capture.support === "checking") return;
    if (connection !== "connected" || !seats.you) {
      setNotice("Join the room before turning on the microphone.");
      return;
    }
    capture.toggle();
  }, [capture, connection, seats.you]);

  const youSide: SpeakerSide = seats.you?.side ?? "a";
  const partnerPresent = seats.partner !== null;
  // Capture holds the floor: the tile glows and the bridge flows while the
  // microphone is on, except during an active interruption.
  const effectiveYouState: SpeakerState =
    capture.capturing &&
    connection === "connected" &&
    youState !== "interrupted"
      ? "speaking"
      : youState;
  const activeSpeaker = toActiveSpeaker(seats, effectiveYouState, partnerState);

  // Attribute the audio currently playing to the seat that spoke it. The
  // pairing only exists in stored data (the transcript row), so an unknown id
  // contributes no label rather than a guessed one.
  const nowPlaying = useMemo<ActivePlayback | null>(() => {
    const active = playbackQueue.nowPlaying;
    if (!active) return null;
    const entry = entries.find(
      (row) => row.utterance.id === active.utteranceId,
    );
    if (!entry) return null;
    return {
      speakerSide: entry.utterance.speakerSide,
      language: active.language,
    };
  }, [entries, playbackQueue.nowPlaying]);

  const interims = useMemo(() => {
    const map: Partial<Record<SpeakerSide, InterimUtterance>> = {};
    if (seats.you && capture.interim.trim().length > 0) {
      map[seats.you.side] = {
        side: seats.you.side,
        text: capture.interim,
        language: speaking,
      };
    }
    if (partnerInterim && partnerInterim.text.trim().length > 0) {
      map[partnerInterim.side] = partnerInterim;
    }
    return map;
  }, [capture.interim, partnerInterim, seats.you, speaking]);

  return {
    connection,
    roomError,
    mic: capture.support === "unsupported" ? "unavailable" : capture.permission,
    speechSupport: capture.support,
    speechTransport: capture.transport,
    recognitionStatus: capture.status,
    recognitionError: capture.error,
    you: seats.you ? { ...seats.you, displayName: "You" } : null,
    partner: seats.partner,
    speakerStates: toSpeakerStates(
      youSide,
      effectiveYouState,
      partnerState,
      partnerPresent,
    ),
    capturing: capture.capturing,
    playback: playbackQueue.state,
    nowPlaying,
    canInterrupt:
      connection === "connected" &&
      seats.you !== null &&
      partnerPresent &&
      !isInterruptPending(interruptState),
    interruptState,
    entries,
    interims,
    notice,
    activeSpeaker,
    flow: toFlow(activeSpeaker),
    bridgeLabel: null,
    broken: toBroken(partnerPresent, connection),
    canSendText: connection === "connected" && seats.you !== null,
    toggleCapture,
    sendText,
    interrupt,
    togglePlayback,
    retryConnection,
  };
}
