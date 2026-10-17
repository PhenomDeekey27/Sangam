"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  InterimUtterance,
  SpeakerState,
} from "@/features/conversation/types";
import { useTranscriptEntries } from "@/features/room/hooks/use-transcript-entries";
import {
  SPEAKING_RESET_MS,
  subscribeRoomSocket,
} from "@/features/room/hooks/subscribe-room-socket";
import type {
  RoomSocketApi,
  SelfIdentity,
  UseRoomSocketOptions,
} from "@/features/room/hooks/use-room-socket-types";
import {
  createRoomActions,
  emitRoomJoin,
} from "@/features/room/services/room-actions";
import { getRoomSocket } from "@/features/room/services/socket";
import type {
  ConnectionStatus,
  ParticipantProfile,
  RoomMode,
} from "@/features/room/types";
import {
  seatsFromSnapshot,
  type SeatAssignment,
} from "@/features/room/utils/derive";
import { useInterruptRequester } from "@/features/room/hooks/use-interrupt-requester";
import type { SocketError } from "@/types/socket";
import { useTimerQueue } from "@/hooks/use-timer-queue";
import {
  expiredRoomError,
  markWasMember,
  shouldTreatAsExpired,
} from "@/features/room/utils/connection";

/**
 * Connects the room screen to the Socket.IO server: lifecycle, join/create
 * with a clean rejoin on reconnect, presence, finalized utterance relay,
 * interim relay, and interruption. Identity always comes from server acks.
 *
 * Transport and membership are separate states: `connected` is reported only
 * after the server's join/create acknowledgement plus the room snapshot that
 * names this participant's seat. A transport that merely connects never
 * implies membership. Listener wiring lives in `subscribe-room-socket` so
 * this hook stays within the file-length budget.
 */
export function useRoomSocket({
  code,
  mode,
  language,
  listeningLanguage,
  notify,
  onSilence,
  onPlayback,
  onPlaybackInterrupt,
  onPlaybackReset,
}: UseRoomSocketOptions): RoomSocketApi {
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [roomError, setRoomError] = useState<SocketError | null>(null);
  const [seats, setSeats] = useState<SeatAssignment>({
    you: null,
    partner: null,
  });
  const { entries, applyUtterance, applyHistory, applyTranslation } =
    useTranscriptEntries();
  const [partnerInterim, setPartnerInterim] = useState<InterimUtterance | null>(
    null,
  );
  const [youState, setYouState] = useState<SpeakerState>("idle");
  const [partnerState, setPartnerState] = useState<SpeakerState>("idle");

  const { schedule, clear: clearTimers } = useTimerQueue();

  const selfRef = useRef<SelfIdentity | null>(null);
  const seatsRef = useRef<SeatAssignment>(seats);
  const partnerNameRef = useRef<string | null>(null);
  const pendingSnapshotRef = useRef<readonly ParticipantProfile[] | null>(null);
  const notifyRef = useRef(notify);
  const silenceRef = useRef(onSilence);
  const playbackRef = useRef(onPlayback);
  const playbackInterruptRef = useRef(onPlaybackInterrupt);
  const playbackResetRef = useRef(onPlaybackReset);
  /**
   * Whether this browser profile was ever seated in this room (this mount or
   * a previous one — session storage survives refresh). Only a previous
   * member may conclude a `room_not_found` means the room is gone rather
   * than mistyped.
   */
  const wasMemberRef = useRef(false);

  // Mutable mirrors of props and state for socket callbacks, refreshed every
  // render so reconnects and rejoins never replay stale values.
  useEffect(() => {
    seatsRef.current = seats;
    partnerNameRef.current = seats.partner?.displayName ?? null;
    notifyRef.current = notify;
    silenceRef.current = onSilence;
    playbackRef.current = onPlayback;
    playbackInterruptRef.current = onPlaybackInterrupt;
    playbackResetRef.current = onPlaybackReset;
  });

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
      const next = seatsFromSnapshot(participants, self.id);
      setSeats(next);
      // Membership is confirmed only with the snapshot that names our seat:
      // an ack alone never flips the UI to connected.
      if (next.you) {
        setConnection("connected");
      }
    },
    [],
  );

  /** Send this seat's create/join with its current preferences (never stale). */
  const enterRoom = useCallback(
    (attempt: RoomMode) => {
      emitRoomJoin(
        getRoomSocket(),
        attempt,
        { code, language, listeningLanguage },
        {
          notify: (message) => notifyRef.current(message),
          silence: () => silenceRef.current(),
          onRoomError: (error) => {
            if (shouldTreatAsExpired(wasMemberRef.current, error.code)) {
              // This profile was seated here and the room is now unknown:
              // the in-memory room is gone (backend restart or expiry).
              // Report it terminally instead of looping on a dead code.
              setRoomError(expiredRoomError());
              setConnection("expired");
              notifyRef.current(null);
              silenceRef.current();
              return;
            }
            setRoomError(error);
            setConnection("disconnected");
            notifyRef.current(null);
          },
          onJoined: (self, created) => {
            selfRef.current = self;
            wasMemberRef.current = true;
            markWasMember(code);
            setRoomError(null);
            // The server always emits the snapshot before the ack, so the
            // pending flush below is the membership proof — not the ack.
            const pending = pendingSnapshotRef.current;
            if (pending) {
              pendingSnapshotRef.current = null;
              const next = seatsFromSnapshot(pending, self.id);
              setSeats(next);
              if (next.you) {
                setConnection("connected");
              }
            } else if (seatsRef.current.you) {
              setConnection("connected");
            }
            notifyRef.current(
              created
                ? "Room created — share the code so your partner can join."
                : null,
            );
          },
          onTimeout: () => {
            // The backend died mid-join: stay out of `connected` and offer
            // the retry path instead of hanging on "connecting" forever.
            setConnection("failed");
            notifyRef.current(
              "The room server did not answer — reconnect to retry.",
            );
            silenceRef.current();
          },
        },
      );
    },
    [code, language, listeningLanguage],
  );

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
      }),
    [language, notify, partnerPresent, selfId],
  );

  // The requester-side interruption state machine lives in its own hook; it
  // emits through the shared send paths and reports the phase for the button.
  const requester = useInterruptRequester({
    sendRequest: actions.interrupt,
    notify,
    setPartnerState,
    schedule,
  });

  useEffect(() => {
    return subscribeRoomSocket({
      socket: getRoomSocket(),
      code,
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
      partnerNameRef,
      onInterruptConfirmed: requester.confirm,
      onInterruptDisconnected: requester.disconnect,
      pendingSnapshotRef,
      wasMemberRef,
      setSeats,
      setConnection,
      setPartnerInterim,
      setYouState,
      setPartnerState,
    });
    // The socket wiring (listeners, connect, teardown) re-runs when the room
    // code or this seat's preferences change, so a reconnect — or opening an
    // invite link in the same tab — always joins with the current values.
  }, [
    applyHistory,
    applySnapshot,
    applyTranslation,
    applyUtterance,
    clearTimers,
    code,
    enterRoom,
    mode,
    partnerActivity,
    requester.confirm,
    requester.disconnect,
    schedule,
  ]);

  const retryConnection = useCallback(() => {
    const socket = getRoomSocket();
    setRoomError(null);
    // A retry after `expired` re-attempts the same code once — it never
    // recreates the room, and a still-missing room reports `expired` again
    // instead of looping on its own.
    setConnection(wasMemberRef.current ? "reconnecting" : "connecting");
    notifyRef.current("Reconnecting…");
    if (socket.connected) {
      enterRoom(mode);
    } else {
      socket.connect();
    }
  }, [enterRoom, mode]);

  return {
    connection,
    roomError,
    seats,
    entries,
    partnerInterim,
    youState,
    partnerState,
    interruptState: requester.state,
    retryConnection,
    sendUtterance: actions.sendUtterance,
    emitInterim: actions.emitInterim,
    interrupt: requester.request,
  };
}
