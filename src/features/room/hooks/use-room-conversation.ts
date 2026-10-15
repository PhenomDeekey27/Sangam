"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  InterimUtterance,
  SpeakerState,
  TranscriptEntry,
} from "@/features/conversation/types";
import { useRoomSocket } from "@/features/room/hooks/use-room-socket";
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
import type {
  MicPermission,
  PlaybackState,
  RecognitionStatus,
  SpeechError,
} from "@/features/speech/types";
import type { SocketError } from "@/types/socket";
import type { LanguageCode } from "@/types";

export interface RoomConversationOptions {
  readonly code: string;
  readonly mode: RoomMode;
  readonly youLanguage: LanguageCode;
  /**
   * The partner's spoken language, carried for the translation stage. Not
   * consumed yet — messages are relayed untranslated.
   */
  readonly partnerLanguage: LanguageCode;
}

/** State and actions the room UI needs. */
export interface RoomConversation {
  readonly connection: ConnectionStatus;
  /** Fatal membership failure (unknown room, full room) for the error banner. */
  readonly roomError: SocketError | null;
  readonly mic: MicPermission;
  /** Browser lacks `SpeechRecognition`; the mic button is disabled. */
  readonly speechSupported: boolean;
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
  youLanguage,
}: RoomConversationOptions): RoomConversation {
  const [notice, setNotice] = useState<string | null>(null);
  const notify = useCallback(
    (message: string | null) => setNotice(message),
    [],
  );
  const captureStopRef = useRef<() => void>(() => {});
  const setCaptureStop = useCallback((stop: () => void) => {
    captureStopRef.current = stop;
  }, []);

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
    language: youLanguage,
    notify,
    onSilence: () => captureStopRef.current(),
  });

  const sendRecognized = useCallback(
    (text: string) => sendUtterance(text, "speech"),
    [sendUtterance],
  );

  const capture = useSpeechCapture({
    language: youLanguage,
    onFinalText: sendRecognized,
    onInterimEmit: emitInterim,
    onNotice: notify,
  });

  useEffect(() => {
    setCaptureStop(capture.stop);
  }, [capture.stop, setCaptureStop]);

  const sendText = useCallback(
    (text: string) => sendUtterance(text, "typed"),
    [sendUtterance],
  );

  const toggleCapture = useCallback(() => {
    if (connection !== "connected" || !seats.you) {
      setNotice("Join the room before turning on the microphone.");
      return;
    }
    capture.toggle();
  }, [capture, connection, seats.you]);

  const stopPlayback = useCallback(() => {
    setNotice("Audio playback arrives in a later stage — nothing is playing.");
  }, []);

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
        language: youLanguage,
      };
    }
    if (partnerInterim && partnerInterim.text.trim().length > 0) {
      map[partnerInterim.side] = partnerInterim;
    }
    return map;
  }, [capture.interim, partnerInterim, seats.you, youLanguage]);

  return {
    connection,
    roomError,
    mic: capture.supported ? capture.permission : "unavailable",
    speechSupported: capture.supported,
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
    playback: { status: "idle" } satisfies PlaybackState,
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
