"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  InterimUtterance,
  SpeakerState,
  TranscriptEntry,
} from "@/features/conversation/types";
import { useTranscriptEntries } from "@/features/room/hooks/use-transcript-entries";
import { createRoomActions } from "@/features/room/services/room-actions";
import {
  destroyRoomSocket,
  getRoomSocket,
} from "@/features/room/services/socket";
import { setSpeechCapabilities } from "@/features/speech/services/speech-capabilities";
import type {
  ConnectionStatus,
  ParticipantProfile,
  RoomMode,
  SpeakerSide,
} from "@/features/room/types";
import {
  seatsFromSnapshot,
  type SeatAssignment,
} from "@/features/room/utils/derive";
import type {
  RoomOpAck,
  SocketError,
  SpeechCapabilities,
} from "@/types/socket";
import type { LanguageCode } from "@/types";
import { useTimerQueue } from "@/hooks/use-timer-queue";

/** How long partner feedback lingers before seats return to idle. */
const SPEAKING_RESET_MS = 1400;

/** Identity the server assigned to this connection's membership. */
interface SelfIdentity {
  readonly id: string;
  readonly side: SpeakerSide;
}

export interface UseRoomSocketOptions {
  readonly code: string;
  readonly mode: RoomMode;
  /** This participant's spoken language, stamped on every utterance. */
  readonly language: LanguageCode;
  /** This participant's "I want to hear" preference, stored on their seat. */
  readonly listeningLanguage: LanguageCode;
  /** Report status messages to the shared `aria-live` region. */
  readonly notify: (message: string | null) => void;
  /** The connection dropped or membership failed: stop live capture. */
  readonly onSilence: () => void;
}

/** Socket lifecycle, membership, transcript relay, and interim lines. */
export interface RoomSocketApi {
  readonly connection: ConnectionStatus;
  /** Fatal membership failure (unknown room, full room) for the error banner. */
  readonly roomError: SocketError | null;
  readonly seats: SeatAssignment;
  readonly entries: readonly TranscriptEntry[];
  /** Replaceable interim line the partner is speaking right now. */
  readonly partnerInterim: InterimUtterance | null;
  readonly youState: SpeakerState;
  readonly partnerState: SpeakerState;
  readonly retryConnection: () => void;
  /** Relay a finalized utterance under a fresh client-generated id. */
  readonly sendUtterance: (text: string, source: "typed" | "speech") => void;
  /** Send the current interim line; empty text clears the partner's view. */
  readonly emitInterim: (text: string) => void;
  readonly interrupt: () => void;
}

/**
 * Connects the room screen to the Socket.IO server: lifecycle, join/create
 * with a clean rejoin on reconnect, presence, finalized utterance relay,
 * interim relay, and interruption. Identity always comes from server acks.
 */
export function useRoomSocket({
  code,
  mode,
  language,
  listeningLanguage,
  notify,
  onSilence,
}: UseRoomSocketOptions): RoomSocketApi {
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [roomError, setRoomError] = useState<SocketError | null>(null);
  const [seats, setSeats] = useState<SeatAssignment>({
    you: null,
    partner: null,
  });
  const { entries, applyUtterance, applyHistory } = useTranscriptEntries();
  const [partnerInterim, setPartnerInterim] = useState<InterimUtterance | null>(
    null,
  );
  const [youState, setYouState] = useState<SpeakerState>("idle");
  const [partnerState, setPartnerState] = useState<SpeakerState>("idle");

  const { schedule, clear: clearTimers } = useTimerQueue();

  const selfRef = useRef<SelfIdentity | null>(null);
  const seatsRef = useRef<SeatAssignment>(seats);
  const enterRoomRef = useRef<(attempt: RoomMode) => void>(() => {});
  const pendingSnapshotRef = useRef<readonly ParticipantProfile[] | null>(null);
  const notifyRef = useRef(notify);
  const silenceRef = useRef(onSilence);

  useEffect(() => {
    seatsRef.current = seats;
  }, [seats]);

  useEffect(() => {
    notifyRef.current = notify;
    silenceRef.current = onSilence;
  }, [notify, onSilence]);

  const partnerActivity = useCallback(() => {
    setPartnerState("speaking");
    schedule(() => setPartnerState("idle"), SPEAKING_RESET_MS);
  }, [schedule]);

  const applySnapshot = useCallback(
    (participants: readonly ParticipantProfile[]) => {
      const self = selfRef.current;
      if (!self) {
        // The snapshot can arrive just before the ack that names us.
        pendingSnapshotRef.current = participants;
        return;
      }
      setSeats(seatsFromSnapshot(participants, self.id));
    },
    [],
  );

  useEffect(() => {
    const socket = getRoomSocket();
    const roomCode = code;

    const enterRoom = (attempt: RoomMode) => {
      // Both preferences ride along on create, join, and every reconnect, so
      // the seat the server re-creates carries the same languages.
      const payload = { code: roomCode, language, listeningLanguage };
      const onResponse = (response: RoomOpAck) => {
        if (!response.ok) {
          if (
            attempt === "create" &&
            response.error.code === "room_already_exists"
          ) {
            // The invite URL can be opened before the creator's room screen
            // finishes creating — fall back to joining the existing room.
            enterRoom("join");
            return;
          }
          setRoomError(response.error);
          setConnection("disconnected");
          notifyRef.current(null);
          silenceRef.current();
          return;
        }
        selfRef.current = response.self;
        setRoomError(null);
        setConnection("connected");
        const pending = pendingSnapshotRef.current;
        if (pending) {
          pendingSnapshotRef.current = null;
          applySnapshot(pending);
        }
        notifyRef.current(
          attempt === "create"
            ? "Room created — share the code so your partner can join."
            : null,
        );
      };
      if (attempt === "create") {
        socket.emit("room:create", payload, onResponse);
      } else {
        socket.emit("room:join", payload, onResponse);
      }
    };
    enterRoomRef.current = enterRoom;

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

    const onInterrupt = (payload: { readonly side: SpeakerSide }) => {
      if (payload.side === selfRef.current?.side) return;
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

    const onConnect = () => {
      setConnection("connecting");
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
      setConnection("disconnected");
      // Capabilities are per-connection; drop them so a stale provider label
      // cannot route the next capture to a server that is no longer reachable.
      setSpeechCapabilities(null);
      notifyRef.current("Connection lost — reconnecting…");
      silenceRef.current();
    };

    const onConnectError = () => {
      setConnection("failed");
      notifyRef.current("Could not reach the room server.");
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.on("room:state", onState);
    socket.on("room:participant_joined", onParticipantJoined);
    socket.on("room:participant_left", onParticipantLeft);
    socket.on("conversation:utterance", onUtterance);
    socket.on("conversation:history", onHistory);
    socket.on("conversation:interim", onInterim);
    socket.on("conversation:interrupt", onInterrupt);
    socket.on("speech:capabilities", onCapabilities);
    socket.on("error", onErrorEvent);

    if (socket.connected) {
      onConnect();
    } else {
      socket.connect();
    }

    return () => {
      // Leave first (the server hears it), then drop the singleton: it removes
      // every listener registered above and disconnects the transport, so no
      // handler from this screen can outlive it.
      if (selfRef.current) {
        socket.emit("room:leave", { code: roomCode });
      }
      destroyRoomSocket();
      setSpeechCapabilities(null);
    };
    // Languages are read through the closure created on mount; a preference
    // change applies to the next join, and every reconnect re-sends the
    // languages this seat joined with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    applyHistory,
    applySnapshot,
    applyUtterance,
    clearTimers,
    partnerActivity,
    schedule,
  ]);

  // Send paths live in one small policy module. `selfId` comes from the seat
  // the server assigned us, so an emit is only attempted once we are seated.
  const selfId = seats.you?.id ?? null;
  const partnerPresent = seats.partner !== null;
  const actions = useMemo(
    () =>
      createRoomActions({
        language,
        selfId,
        partnerPresent,
        notify,
        setSelfState: setYouState,
        setPartnerState,
        clearTimers,
        schedule,
      }),
    [clearTimers, language, notify, partnerPresent, schedule, selfId],
  );

  const retryConnection = useCallback(() => {
    const socket = getRoomSocket();
    setRoomError(null);
    setConnection("connecting");
    notifyRef.current("Reconnecting…");
    if (socket.connected) {
      enterRoomRef.current(mode);
    } else {
      socket.connect();
    }
  }, [mode]);

  return {
    connection,
    roomError,
    seats,
    entries,
    partnerInterim,
    youState,
    partnerState,
    retryConnection,
    ...actions,
  };
}
