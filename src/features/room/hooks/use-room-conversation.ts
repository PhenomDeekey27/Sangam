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
import { useSpeechCapture } from "@/features/speech/hooks/use-speech-capture";
import { usePlaybackQueue } from "@/features/playback/hooks/use-playback-queue";
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
  readonly stopPlayback: () => void;
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
  const playbackQueue = usePlaybackQueue({ onNotice: notify });
  // The stable sinks go straight to the socket subscription: enqueue for new
  // deliveries, interrupt for a remote interruption's boundary, reset for a
  // disconnect/leave so the next room starts clean.
  const {
    enqueue: onPlayback,
    interrupt: onPlaybackInterrupt,
    reset: onPlaybackReset,
    stop: stopPlayback,
  } = playbackQueue;

  const {
    connection,
    roomError,
    seats,
    entries,
    partnerInterim,
    youState,
    partnerState,
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
  });

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
    stopPlayback,
    retryConnection,
  };
}
