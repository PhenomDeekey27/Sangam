import type { Server, Socket } from "socket.io";
import type { RoomManager } from "../rooms/room-manager.js";
import type { RoomParticipant } from "../rooms/room-types.js";
import { ErrorCodes, errorFor } from "../utils/errors.js";
import type {
  ClientToServerEvents,
  RoomOpAck,
  ServerToClientEvents,
} from "./contract.js";
import type { TranslationService } from "../translation/translation-service.js";
import {
  parseInterimPayload,
  parseInterruptPayload,
  parseJoinPayload,
  parseLeavePayload,
  parseUtterancePayload,
} from "./event-validation.js";

type AppServer = Server<ClientToServerEvents, ServerToClientEvents>;
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
type Ack = ((response: RoomOpAck) => void) | undefined;

/**
 * Window within which repeats of `conversation:interrupt` from the same
 * socket are suppressed. Wide enough to absorb a double-tapped button or a
 * briefly stuck client, narrow enough to never delay a deliberate
 * re-interruption in a natural two-way conversation.
 */
export const INTERRUPT_COOLDOWN_MS = 800;

/**
 * One-shot-per-window gate. Returns whether the caller may act now; the
 * window restarts on every accepted call. `now` is injectable for tests.
 */
export function createInterruptGate(
  cooldownMs: number,
  now: () => number = Date.now,
): () => boolean {
  let lastAcceptedAt = Number.NEGATIVE_INFINITY;
  return () => {
    const time = now();
    if (time - lastAcceptedAt < cooldownMs) return false;
    lastAcceptedAt = time;
    return true;
  };
}

/** Socket.IO room-channel name for a Sangam room code. */
export function channelFor(code: string): string {
  return `room:${code}`;
}

/** Wire shape of a participant; only server-known fields are exposed. */
function toProfile(participant: RoomParticipant) {
  return {
    id: participant.id,
    side: participant.side,
    status: "connected" as const,
    displayName: participant.displayName,
    language: participant.language,
    listeningLanguage: participant.listeningLanguage,
  };
}

function replyAck(ack: Ack, response: RoomOpAck): void {
  ack?.(response);
}

/**
 * Finish a successful create/join: bind the socket to the room channel, send
 * the joiner a full snapshot, tell existing members about the arrival (unless
 * this was an idempotent re-join), and ack. Identity (id, side) always comes
 * from the server-side room record.
 */
function confirmJoin(
  io: AppServer,
  socket: AppSocket,
  rooms: RoomManager,
  result: Extract<ReturnType<RoomManager["joinRoom"]>, { ok: true }>,
  ack: Ack,
  announce: boolean,
): void {
  const { room, participant } = result;
  socket.join(channelFor(room.code));
  socket.emit("room:state", rooms.snapshot(room));
  /*
   * Replay this room's retained history to the joiner only — emitted before
   * the ack and before any later live utterance, so the client can order
   * replayed rows ahead of everything it receives afterwards. Interims are
   * never part of history. Membership was just confirmed above, so a joiner
   * can only ever be sent their own room's transcript.
   */
  socket.emit("conversation:history", {
    code: room.code,
    entries: [...rooms.transcriptOf(room)],
  });
  if (announce) {
    socket
      .to(channelFor(room.code))
      .emit("room:participant_joined", { participant: toProfile(participant) });
  }
  replyAck(ack, {
    ok: true,
    self: { id: participant.id, side: participant.side },
  });
}

/** Detach a socket from its current room and notify remaining members. */
function removeMembership(
  io: AppServer,
  socket: AppSocket,
  rooms: RoomManager,
): void {
  const departure = rooms.removeBySocket(socket.id);
  if (!departure) return;
  socket.leave(channelFor(departure.code));
  socket.to(channelFor(departure.code)).emit("room:participant_left", {
    participantId: departure.participant.id,
  });
}

/**
 * If the socket already belongs to a different room, depart it first so the
 * old room's members learn about the leave and the socket.io channel is
 * dropped before the new membership exists.
 */
function leavePreviousRoom(
  io: AppServer,
  socket: AppSocket,
  rooms: RoomManager,
  nextCode: string,
): void {
  const previous = rooms.membershipOf(socket.id);
  if (previous && previous.code !== nextCode) {
    removeMembership(io, socket, rooms);
  }
}

/**
 * Register every room and conversation listener for one connection. Handlers
 * derive identity exclusively from server membership — nothing a client
 * sends can choose a side or impersonate another participant.
 */
export function registerRoomHandlers(
  io: AppServer,
  socket: AppSocket,
  rooms: RoomManager,
  translations: TranslationService | null = null,
): void {
  // Per connection: a fresh socket always starts out allowed to interrupt.
  const interruptCooldownOpen = createInterruptGate(INTERRUPT_COOLDOWN_MS);
  socket.on("room:create", (payload, ack) => {
    const parsed = parseJoinPayload(payload);
    if (!parsed.ok) {
      replyAck(ack, { ok: false, error: parsed.error });
      return;
    }
    const previous = rooms.membershipOf(socket.id);
    leavePreviousRoom(io, socket, rooms, parsed.value.code);
    const result = rooms.createAndJoin(parsed.value.code, {
      socketId: socket.id,
      language: parsed.value.language,
      listeningLanguage: parsed.value.listeningLanguage,
      displayName: parsed.value.displayName ?? "",
    });
    if (!result.ok) {
      replyAck(ack, { ok: false, error: result.error });
      return;
    }
    const announce = previous?.code !== result.room.code;
    confirmJoin(io, socket, rooms, result, ack, announce);
  });

  socket.on("room:join", (payload, ack) => {
    const parsed = parseJoinPayload(payload);
    if (!parsed.ok) {
      replyAck(ack, { ok: false, error: parsed.error });
      return;
    }
    const previous = rooms.membershipOf(socket.id);
    leavePreviousRoom(io, socket, rooms, parsed.value.code);
    const result = rooms.joinRoom(parsed.value.code, {
      socketId: socket.id,
      language: parsed.value.language,
      listeningLanguage: parsed.value.listeningLanguage,
      displayName: parsed.value.displayName ?? "",
    });
    if (!result.ok) {
      replyAck(ack, { ok: false, error: result.error });
      return;
    }
    const announce = previous?.code !== result.room.code;
    confirmJoin(io, socket, rooms, result, ack, announce);
  });

  socket.on("room:leave", (payload) => {
    const membership = rooms.membershipOf(socket.id);
    if (!membership) return;
    const parsed = parseLeavePayload(payload, membership.code);
    if (!parsed.ok) {
      socket.emit("error", parsed.error);
      return;
    }
    removeMembership(io, socket, rooms);
  });

  socket.on("conversation:utterance", (payload) => {
    const membership = rooms.membershipOf(socket.id);
    if (!membership) {
      socket.emit("error", errorFor(ErrorCodes.NOT_IN_ROOM));
      return;
    }
    const parsed = parseUtterancePayload(payload);
    if (!parsed.ok) {
      socket.emit("error", parsed.error);
      return;
    }
    const room = rooms.roomOf(socket.id);
    const participant = rooms.participantOf(socket.id);
    /* c8 ignore next -- membership without participant would be corrupted */
    if (!room || !participant) return;
    const { utteranceId } = parsed.value;
    if (room.usedUtteranceIds.has(utteranceId)) {
      // A re-played id would create a phantom duplicate on clients.
      socket.emit("error", errorFor(ErrorCodes.INVALID_PAYLOAD));
      return;
    }
    room.usedUtteranceIds.add(utteranceId);
    room.utteranceSeq += 1;
    const entry = {
      utterance: {
        id: utteranceId,
        speakerSide: participant.side,
        language: parsed.value.language,
        text: parsed.value.text,
        finalizedAt: Date.now(),
        sequence: room.utteranceSeq,
      },
      translation: { status: "unavailable" as const },
    };
    // Finalized rows join the room's history so a rejoin can replay them;
    // interims are relayed but never retained.
    rooms.recordUtterance(room, entry);
    io.to(channelFor(membership.code)).emit("conversation:utterance", {
      entry,
    });
    // Translate after broadcasting: the original is never delayed by the
    // provider, and the translation updates this same row by utterance id.
    translations?.translateUtterance(room, entry);
  });

  socket.on("conversation:interim", (payload) => {
    const membership = rooms.membershipOf(socket.id);
    if (!membership) {
      socket.emit("error", errorFor(ErrorCodes.NOT_IN_ROOM));
      return;
    }
    const parsed = parseInterimPayload(payload);
    if (!parsed.ok) {
      socket.emit("error", parsed.error);
      return;
    }
    const participant = rooms.participantOf(socket.id);
    /* c8 ignore next -- membership without participant would be corrupted */
    if (!participant) return;
    // The sender renders its own interim locally; only the partner needs it.
    socket.to(channelFor(membership.code)).emit("conversation:interim", {
      side: participant.side,
      text: parsed.value.text,
      language: parsed.value.language,
    });
  });

  socket.on("conversation:interrupt", (payload, ack) => {
    const membership = rooms.membershipOf(socket.id);
    if (!membership) {
      socket.emit("error", errorFor(ErrorCodes.NOT_IN_ROOM));
      ack?.({ ok: false, error: errorFor(ErrorCodes.NOT_IN_ROOM) });
      return;
    }
    const participant = rooms.participantOf(socket.id);
    /* c8 ignore next -- membership without participant would be corrupted */
    if (!participant) return;
    const parsed = parseInterruptPayload(payload);
    if (!parsed.ok) {
      ack?.({ ok: false, error: parsed.error });
      return;
    }
    const room = rooms.roomOf(socket.id);
    /* c8 ignore next -- membership without room would be corrupted */
    if (!room) return;
    // A rapid repeat is refused rather than silently dropped, so the requester
    // learns its request was not relayed and can retry deliberately.
    if (!interruptCooldownOpen()) {
      ack?.({ ok: false, error: errorFor(ErrorCodes.RATE_LIMITED) });
      return;
    }
    // Nothing to interrupt with an empty room: report it as unrelayed instead
    // of pretending the partner's audio stopped.
    if (room.participants.size < 2) {
      ack?.({
        ok: true,
        interruptId: parsed.value.interruptId,
        relayed: false,
      });
      return;
    }
    // Remember the request so the partner's confirmation can be routed back to
    // this socket. The boundary is the room's newest relayed utterance: the
    // recipient stops audio at or below it and rejects late frames for that
    // turn, while a later utterance (higher sequence) is new speech.
    room.pendingInterrupt = {
      interruptId: parsed.value.interruptId,
      requesterSocketId: socket.id,
    };
    socket.to(channelFor(membership.code)).emit("conversation:interrupt", {
      side: participant.side,
      sequence: room.utteranceSeq,
      interruptId: parsed.value.interruptId,
    });
    ack?.({
      ok: true,
      interruptId: parsed.value.interruptId,
      relayed: true,
    });
  });

  socket.on("conversation:interrupt_ack", (payload) => {
    // Only the interrupted partner sends this. The requester's own id never
    // matches, and a stale confirmation for an older request is ignored.
    const membership = rooms.membershipOf(socket.id);
    if (!membership) return;
    const participant = rooms.participantOf(socket.id);
    /* c8 ignore next -- membership without participant would be corrupted */
    if (!participant) return;
    const parsed = parseInterruptPayload(payload);
    if (!parsed.ok) return;
    const room = rooms.roomOf(socket.id);
    const pending = room?.pendingInterrupt;
    if (!pending || pending.interruptId !== parsed.value.interruptId) return;
    if (pending.requesterSocketId === socket.id) return;
    io.to(pending.requesterSocketId).emit("conversation:interrupt_confirmed", {
      side: participant.side,
      interruptId: parsed.value.interruptId,
    });
  });
}

/** Disconnect handling: release membership and announce the departure. */
export function handleDisconnect(
  io: AppServer,
  socket: AppSocket,
  rooms: RoomManager,
): void {
  removeMembership(io, socket, rooms);
}
