"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  InterimUtterance,
  SpeakerState,
  TranscriptEntry,
} from "@/features/conversation/types";
import { newUtteranceId } from "@/features/conversation/utils/utterance-id";
import {
  destroyRoomSocket,
  getRoomSocket,
} from "@/features/room/services/socket";
import type {
  ConnectionStatus,
  ParticipantProfile,
  RoomMode,
  SpeakerSide,
} from "@/features/room/types";
import { type SeatAssignment } from "@/features/room/utils/derive";
import type { RoomOpAck, SocketError } from "@/types/socket";
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
  notify,
  onSilence,
}: UseRoomSocketOptions): RoomSocketApi {
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [roomError, setRoomError] = useState<SocketError | null>(null);
  const [seats, setSeats] = useState<SeatAssignment>({
    you: null,
    partner: null,
  });
  const [entries, setEntries] = useState<readonly TranscriptEntry[]>([]);
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
  const entryIdsRef = useRef(new Set<string>());
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
      setSeats({
        you:
          participants.find((participant) => participant.id === self.id) ??
          null,
        partner:
          participants.find((participant) => participant.id !== self.id) ??
          null,
      });
    },
    [],
  );

  useEffect(() => {
    const socket = getRoomSocket();
    const roomCode = code;

    const enterRoom = (attempt: RoomMode) => {
      const payload = { code: roomCode, language };
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
      if (entryIdsRef.current.has(payload.entry.utterance.id)) return;
      entryIdsRef.current.add(payload.entry.utterance.id);
      setEntries((previous) => [...previous, payload.entry]);
      const self = selfRef.current;
      if (self && payload.entry.utterance.speakerSide === self.side) return;
      setPartnerInterim(null);
      partnerActivity();
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
    socket.on("conversation:interim", onInterim);
    socket.on("conversation:interrupt", onInterrupt);
    socket.on("error", onErrorEvent);

    if (socket.connected) {
      onConnect();
    } else {
      socket.connect();
    }

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      socket.off("room:state", onState);
      socket.off("room:participant_joined", onParticipantJoined);
      socket.off("room:participant_left", onParticipantLeft);
      socket.off("conversation:utterance", onUtterance);
      socket.off("conversation:interim", onInterim);
      socket.off("conversation:interrupt", onInterrupt);
      socket.off("error", onErrorEvent);
      if (selfRef.current) {
        socket.emit("room:leave", { code: roomCode });
      }
      destroyRoomSocket();
    };
    // `language` is read through the closure created on mount; live language
    // switches apply to the next join, not mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applySnapshot, clearTimers, partnerActivity, schedule]);

  const sendUtterance = useCallback(
    (raw: string, source: "typed" | "speech") => {
      const text = raw.trim();
      if (!text) return;
      const socket = getRoomSocket();
      if (!socket.connected || !selfRef.current) {
        notifyRef.current("Not connected — reconnect before sending messages.");
        return;
      }
      socket.emit("conversation:utterance", {
        utteranceId: newUtteranceId(),
        text,
        language,
      });
      if (source === "typed") {
        notifyRef.current(
          seatsRef.current.partner
            ? "Message sent — translation is not applied yet, so it arrives as-is."
            : "Nobody else is connected — only this room's live transcript has your message.",
        );
      } else if (!seatsRef.current.partner) {
        notifyRef.current(
          "Nobody else is connected yet — your words are in this room's transcript.",
        );
      }
    },
    [language],
  );

  const emitInterim = useCallback(
    (text: string) => {
      const socket = getRoomSocket();
      if (!socket.connected || !selfRef.current) return;
      socket.emit("conversation:interim", { text, language });
    },
    [language],
  );

  const interrupt = useCallback(() => {
    const socket = getRoomSocket();
    if (!socket.connected || !selfRef.current) return;
    socket.emit("conversation:interrupt");
    clearTimers();
    setYouState("speaking");
    setPartnerState("interrupted");
    notifyRef.current(
      seatsRef.current.partner
        ? "You interrupted your partner."
        : "Interrupted — nobody else is in the room right now.",
    );
    schedule(() => {
      setYouState("idle");
      setPartnerState("idle");
    }, SPEAKING_RESET_MS);
  }, [clearTimers, schedule]);

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
    sendUtterance,
    emitInterim,
    interrupt,
  };
}
