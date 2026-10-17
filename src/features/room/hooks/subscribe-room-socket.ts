"use client";

import type { Dispatch, RefObject, SetStateAction } from "react";
import type {
  InterimUtterance,
  SpeakerState,
  TranscriptEntry,
} from "@/features/conversation/types";
import type {
  ConnectionStatus,
  ParticipantProfile,
  RoomMode,
  SpeakerSide,
} from "@/features/room/types";
import { type SeatAssignment } from "@/features/room/utils/derive";
import {
  destroyRoomSocket,
  type RoomSocket,
} from "@/features/room/services/socket";
import { setSpeechCapabilities } from "@/features/speech/services/speech-capabilities";
import { parseTranslationUpdate } from "@/features/conversation/utils/translation-payload";
import { parsePlaybackPayload } from "@/features/playback/services/playback-payload";
import type { TranslationState } from "@/features/translation/types";
import { readWasMember } from "@/features/room/utils/connection";
import type { LanguageCode } from "@/types";
import type {
  PlaybackPayload,
  SocketError,
  SpeechCapabilities,
} from "@/types/socket";
import type { SelfIdentity } from "./use-room-socket-types";

/** How long partner feedback lingers before seats return to idle. */
export const SPEAKING_RESET_MS = 1400;

/**
 * Normalize a server-stamped interruption boundary at the socket boundary. A
 * missing or malformed value degrades to `0`, which stops the active audio
 * without discarding anything (the safe direction), so a bad frame can never
 * drop legitimate queued speech.
 */
export function interruptBoundary(sequence: unknown): number {
  if (typeof sequence !== "number" || !Number.isFinite(sequence)) return 0;
  return sequence > 0 ? Math.floor(sequence) : 0;
}

/** Everything the socket subscriptions need from the owning hook. */
export interface RoomSubscriptionContext {
  readonly socket: RoomSocket;
  readonly code: string;
  readonly mode: RoomMode;
  /** Send this seat's create/join with its current preferences. */
  readonly enterRoom: (attempt: RoomMode) => void;
  /** Apply a server snapshot to this participant's seats. */
  readonly applySnapshot: (participants: readonly ParticipantProfile[]) => void;
  readonly applyUtterance: (entry: TranscriptEntry) => boolean;
  readonly applyHistory: (entries: readonly TranscriptEntry[]) => void;
  /** Update one stored row's translation; `false` when the id is unknown. */
  readonly applyTranslation: (
    utteranceId: string,
    translation: TranslationState,
  ) => boolean;
  readonly partnerActivity: () => void;
  readonly schedule: (callback: () => void, ms: number) => void;
  readonly clearTimers: () => void;
  readonly notifyRef: RefObject<(message: string | null) => void>;
  readonly silenceRef: RefObject<() => void>;
  /** Stage-6 playback sink; the hook owns the queue and player. */
  readonly playbackRef: RefObject<
    (payload: PlaybackPayload, audio: ArrayBuffer) => void
  >;
  /** Stage-7 interruption sink: stop and discard up to the server boundary. */
  readonly playbackInterruptRef: RefObject<(sequence: number) => void>;
  /** Stage-7 teardown sink: stop and forget all playback (disconnect/leave). */
  readonly playbackResetRef: RefObject<() => void>;
  readonly selfRef: RefObject<SelfIdentity | null>;
  readonly pendingSnapshotRef: RefObject<readonly ParticipantProfile[] | null>;
  readonly wasMemberRef: RefObject<boolean>;
  readonly setSeats: Dispatch<SetStateAction<SeatAssignment>>;
  readonly setConnection: Dispatch<SetStateAction<ConnectionStatus>>;
  readonly setPartnerInterim: Dispatch<SetStateAction<InterimUtterance | null>>;
  readonly setYouState: Dispatch<SetStateAction<SpeakerState>>;
  readonly setPartnerState: Dispatch<SetStateAction<SpeakerState>>;
}

/**
 * Register every room and conversation listener for one subscription, dial
 * when needed, and return the teardown. The teardown leaves the room
 * server-side first, then drops the singleton (removing every listener and
 * disconnecting the transport), so no handler from one screen can outlive it
 * or duplicate the next subscription's listeners across refreshes and React
 * remounts.
 */
export function subscribeRoomSocket(
  context: RoomSubscriptionContext,
): () => void {
  const {
    socket,
    code: roomCode,
    mode,
    enterRoom,
    applySnapshot,
    applyUtterance,
    applyHistory,
    applyTranslation,
    partnerActivity,
    schedule,
    clearTimers,
    notifyRef,
    silenceRef,
    playbackRef,
    playbackInterruptRef,
    playbackResetRef,
    selfRef,
    pendingSnapshotRef,
    wasMemberRef,
    setSeats,
    setConnection,
    setPartnerInterim,
    setYouState,
    setPartnerState,
  } = context;
  // A refresh must not forget previous membership: it decides whether a
  // later `room_not_found` reads as "room is gone" or "wrong code".
  if (readWasMember(roomCode)) {
    wasMemberRef.current = true;
  }

  const onState = (payload: {
    readonly participants: readonly ParticipantProfile[];
  }) => {
    applySnapshot(payload.participants);
  };

  const onParticipantJoined = (payload: {
    readonly participant: ParticipantProfile;
  }) => {
    const self = selfRef.current;
    if (self && payload.participant.id === self.id) return;
    setSeats((previous) => ({ ...previous, partner: payload.participant }));
    setPartnerState("idle");
    notifyRef.current(`${payload.participant.displayName} joined the room.`);
  };

  const onParticipantLeft = (payload: { readonly participantId: string }) => {
    const self = selfRef.current;
    if (self && payload.participantId === self.id) {
      selfRef.current = null;
      setSeats({ you: null, partner: null });
      return;
    }
    clearTimers();
    setPartnerState("idle");
    setPartnerInterim(null);
    setSeats((previous) => ({ ...previous, partner: null }));
    notifyRef.current(
      "Your partner left the room. They can rejoin with the code.",
    );
  };

  const onUtterance = (payload: { readonly entry: TranscriptEntry }) => {
    if (!applyUtterance(payload.entry)) return;
    const self = selfRef.current;
    if (self && payload.entry.utterance.speakerSide === self.side) return;
    setPartnerInterim(null);
    partnerActivity();
  };

  const onTranslation = (payload: unknown) => {
    // Updates the stored row in place — never appends a duplicate utterance.
    const update = parseTranslationUpdate(payload);
    if (!update) return;
    applyTranslation(update.utteranceId, update.translation);
  };

  const onHistory = (payload: {
    readonly code: string;
    readonly entries: readonly TranscriptEntry[];
  }) => {
    // Only this room's history is accepted; the merge never duplicates a row
    // and orders by the server's per-room sequence.
    if (payload.code !== roomCode) return;
    applyHistory(payload.entries);
  };

  const onInterim = (payload: {
    readonly side: SpeakerSide;
    readonly text: string;
    readonly language: LanguageCode;
  }) => {
    const self = selfRef.current;
    if (self && payload.side === self.side) return;
    if (payload.text.trim().length === 0) {
      setPartnerInterim(null);
      return;
    }
    setPartnerInterim({
      side: payload.side,
      text: payload.text,
      language: payload.language,
    });
    partnerActivity();
  };

  const onInterrupt = (payload: {
    readonly side: SpeakerSide;
    readonly sequence?: unknown;
  }) => {
    // A participant's own interruption signal never arrives here in practice
    // (the server relays it only to the partner), and must never stop their
    // own playback if it did. Transcripts are untouched either way.
    if (payload.side === selfRef.current?.side) return;
    // Mute the interrupted turn and reject its late audio before the visual
    // highlight settles. The boundary is whatever the server stamped.
    playbackInterruptRef.current(interruptBoundary(payload.sequence));
    clearTimers();
    setYouState("interrupted");
    setPartnerState("speaking");
    notifyRef.current(
      "Your partner interrupted — their words stay in the transcript.",
    );
    schedule(() => {
      setYouState("idle");
      setPartnerState("idle");
    }, SPEAKING_RESET_MS);
  };

  const onErrorEvent = (error: SocketError) => {
    notifyRef.current(error.message);
  };

  const onCapabilities = (payload: SpeechCapabilities) => {
    setSpeechCapabilities(payload);
  };

  /**
   * Stage-6 playback delivery. The payload and binary audio come as two
   * arguments; both are normalized before the queue sees them, so a bad
   * frame can neither corrupt the queue nor crash the subscription. The
   * engine may hand binary over as a Blob depending on transport settings.
   */
  const onPlayback = (payload: unknown, audio: unknown): void => {
    const parsed = parsePlaybackPayload(payload);
    if (!parsed) return;
    const bytes = normalizeAudio(audio, (blobBytes) => {
      playbackRef.current(parsed, blobBytes);
    });
    if (bytes) playbackRef.current(parsed, bytes);
  };

  const onConnect = () => {
    // A bare transport is not membership: stay out of `connected` until
    // the join/create ack plus the snapshot naming our seat arrive.
    setConnection(wasMemberRef.current ? "reconnecting" : "connecting");
    enterRoom(mode);
  };

  const onDisconnect = () => {
    selfRef.current = null;
    pendingSnapshotRef.current = null;
    clearTimers();
    setYouState("idle");
    setPartnerState("idle");
    setPartnerInterim(null);
    setSeats({ you: null, partner: null });
    // Interrupted, not gone: the transport may still come back and rejoin.
    setConnection("reconnecting");
    // Capabilities are per-connection; drop them so a stale provider label
    // cannot route the next capture to a server that is no longer reachable.
    setSpeechCapabilities(null);
    notifyRef.current("Connection lost — reconnecting…");
    silenceRef.current();
    // A dropped transport must not leave translated audio playing from a room
    // we are no longer connected to; a rejoining seat replays no audio.
    playbackResetRef.current();
  };

  const onConnectError = () => {
    // Attempts are still in flight (bounded by the socket's retry
    // budget): report the interruption, not a terminal failure.
    setConnection("reconnecting");
    notifyRef.current("Connection lost — reconnecting…");
  };

  const onReconnectAttempt = () => {
    setConnection("reconnecting");
    notifyRef.current("Connection lost — reconnecting…");
  };

  const onReconnectFailed = () => {
    // The retry budget is spent and no join will be attempted until the
    // user acts: surface the terminal state with its retry action.
    setConnection("failed");
    notifyRef.current("Could not reach the room server.");
    silenceRef.current();
  };

  /**
   * Normalize the binary audio argument across transports: WebSocket
   * delivers `ArrayBuffer`, long-polling may hand a `Blob`, and anything
   * else is treated as unusable rather than crashing the queue. A Blob
   * resolves through `onBlob` later; playback ordering is enforced by the
   * queue's `sequence`, not arrival timing.
   */
  function normalizeAudio(
    value: unknown,
    onBlob: (bytes: ArrayBuffer) => void,
  ): ArrayBuffer | null {
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(
        value.byteOffset,
        value.byteOffset + value.byteLength,
      ) as ArrayBuffer;
    }
    if (typeof Blob !== "undefined" && value instanceof Blob) {
      void value
        .arrayBuffer()
        .then(onBlob)
        .catch(() => undefined);
      return null;
    }
    return null;
  }

  socket.on("connect", onConnect);
  socket.on("disconnect", onDisconnect);
  socket.on("connect_error", onConnectError);
  // Reconnect bookkeeping lives on the manager: the socket surface only
  // carries namespace events, so these two would not typecheck there.
  socket.io.on("reconnect_attempt", onReconnectAttempt);
  socket.io.on("reconnect_failed", onReconnectFailed);
  socket.on("room:state", onState);
  socket.on("room:participant_joined", onParticipantJoined);
  socket.on("room:participant_left", onParticipantLeft);
  socket.on("conversation:utterance", onUtterance);
  socket.on("conversation:translation", onTranslation);
  socket.on("conversation:history", onHistory);
  socket.on("conversation:interim", onInterim);
  socket.on("conversation:interrupt", onInterrupt);
  socket.on("conversation:playback", onPlayback);
  socket.on("speech:capabilities", onCapabilities);
  socket.on("error", onErrorEvent);

  if (socket.connected) {
    onConnect();
  } else {
    socket.connect();
  }

  return () => {
    socket.io.off("reconnect_attempt", onReconnectAttempt);
    socket.io.off("reconnect_failed", onReconnectFailed);
    if (selfRef.current) {
      socket.emit("room:leave", { code: roomCode });
    }
    // Leaving (or switching) a room must leave the player empty and consistent
    // so the next room's sequence numbering starts from a clean watermark.
    playbackResetRef.current();
    destroyRoomSocket();
    setSpeechCapabilities(null);
  };
}
