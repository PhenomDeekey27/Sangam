import { randomUUID } from "node:crypto";
import { errorFor, ErrorCodes, type WireError } from "../utils/errors.js";
import { isRoomCode, normalizeRoomCode } from "./room-validation.js";
import type {
  Departure,
  JoinResult,
  Membership,
  ParticipantSide,
  Room,
  RoomParticipant,
  RoomSnapshot,
  RoomStatus,
} from "./room-types.js";

/**
 * How long a room with zero participants lingers before deletion. This gives
 * a briefly disconnected pair a chance to rejoin the same code instead of
 * finding it gone; after the window the room is swept. Reservations that are
 * never claimed expire by the same rule.
 */
export const EMPTY_ROOM_TTL_MS = 60_000;

const SEQUENTIAL_SIDES: readonly ParticipantSide[] = ["a", "b"];

function sideFree(room: Room, side: ParticipantSide): boolean {
  return !room.participants.has(side);
}

function firstFreeSide(room: Room): ParticipantSide | null {
  return SEQUENTIAL_SIDES.find((side) => sideFree(room, side)) ?? null;
}

function defaultDisplayName(side: ParticipantSide): string {
  return side === "a" ? "Speaker A" : "Speaker B";
}

/**
 * In-memory authority for rooms and membership. A room exists only between
 * `createRoom`/`joinRoom(create)` and the empty-room sweep — nothing is
 * persisted, so a server restart forgets every room and transcript.
 *
 * One `RoomManager` instance must back a single Socket.IO server: membership
 * is keyed by socket id and is not shared between processes.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly memberships = new Map<string, Membership>();

  /** Number of live rooms (including reservations with zero members). */
  get roomCount(): number {
    return this.rooms.size;
  }

  /**
   * Reserve a fresh room code without adding any participant. Used by the
   * create flow so an unclaimed code cannot be squatted through `join`.
   */
  createRoom(
    rawCode: string,
  ):
    | { readonly ok: true; readonly room: Room }
    | { readonly ok: false; readonly error: WireError } {
    if (!isRoomCode(rawCode)) {
      return { ok: false, error: errorFor(ErrorCodes.INVALID_CODE) };
    }
    const code = normalizeRoomCode(rawCode);
    if (this.rooms.has(code)) {
      return { ok: false, error: errorFor(ErrorCodes.ROOM_ALREADY_EXISTS) };
    }
    const room: Room = {
      code,
      createdAt: Date.now(),
      emptySince: Date.now(),
      participants: new Map(),
      utteranceSeq: 0,
      usedUtteranceIds: new Set(),
    };
    this.rooms.set(code, room);
    return { ok: true, room };
  }

  /**
   * Create a room and immediately seat the caller as side `a`. This is the
   * socket-level create used by the room screen's create mode.
   */
  createAndJoin(
    rawCode: string,
    joiner: Omit<RoomParticipant, "id" | "side" | "joinedAt">,
  ): JoinResult {
    const reservation = this.createRoom(rawCode);
    if (!reservation.ok) return reservation;
    const joined = this.joinRoom(rawCode, joiner);
    /* c8 ignore next 3 -- room was just created; join cannot fail */
    if (!joined.ok) {
      this.rooms.delete(normalizeRoomCode(rawCode));
      return joined;
    }
    return { ...joined, created: true };
  }

  /**
   * Seat a participant in an existing room: first free side (the creator's
   * reservation always yields `a` first), refusing when both are taken.
   * Re-joining a room the socket already belongs to is idempotent.
   */
  joinRoom(
    rawCode: string,
    joiner: Omit<RoomParticipant, "id" | "side" | "joinedAt">,
  ): JoinResult {
    if (!isRoomCode(rawCode)) {
      return { ok: false, error: errorFor(ErrorCodes.INVALID_CODE) };
    }
    const code = normalizeRoomCode(rawCode);

    const existingMembership = this.memberships.get(joiner.socketId);
    if (existingMembership) {
      if (existingMembership.code === code) {
        const room = this.rooms.get(code);
        const participant = room && this.findBySocket(room, joiner.socketId);
        if (room && participant) {
          return { ok: true, room, participant, created: false };
        }
      }
      // A socket switching rooms must leave the previous one first.
      this.removeBySocket(joiner.socketId);
    }

    const room = this.rooms.get(code);
    if (!room) {
      return { ok: false, error: errorFor(ErrorCodes.ROOM_NOT_FOUND) };
    }
    const side = firstFreeSide(room);
    if (!side) {
      return { ok: false, error: errorFor(ErrorCodes.ROOM_FULL) };
    }

    const participant: RoomParticipant = {
      ...joiner,
      id: randomUUID(),
      side,
      joinedAt: Date.now(),
      displayName: joiner.displayName || defaultDisplayName(side),
    };
    room.participants.set(side, participant);
    room.emptySince = null;
    this.memberships.set(joiner.socketId, {
      code,
      participantId: participant.id,
      side,
    });
    return { ok: true, room, participant, created: false };
  }

  /** Remove a socket's membership, if any, and report who remains. */
  removeBySocket(socketId: string): Departure | null {
    const membership = this.memberships.get(socketId);
    if (!membership) return null;
    this.memberships.delete(socketId);

    const room = this.rooms.get(membership.code);
    /* c8 ignore next -- membership without room would be corrupted state */
    if (!room) return null;

    const participant = room.participants.get(membership.side);
    /* c8 ignore next -- membership without participant would be corrupted */
    if (!participant || participant.socketId !== socketId) return null;
    room.participants.delete(membership.side);

    const remaining = [...room.participants.values()];
    if (remaining.length === 0) {
      room.emptySince = Date.now();
    }
    return {
      code: room.code,
      participant,
      remaining,
      roomEmpty: remaining.length === 0,
    };
  }

  /** Membership lookup for a connected socket. */
  membershipOf(socketId: string): Membership | null {
    return this.memberships.get(socketId) ?? null;
  }

  /** Participant record bound to a socket, if it is still a member. */
  participantOf(socketId: string): RoomParticipant | null {
    const membership = this.memberships.get(socketId);
    if (!membership) return null;
    const room = this.rooms.get(membership.code);
    return room?.participants.get(membership.side) ?? null;
  }

  /** Room for a socket's membership, if any. */
  roomOf(socketId: string): Room | null {
    const membership = this.memberships.get(socketId);
    if (!membership) return null;
    return this.rooms.get(membership.code) ?? null;
  }

  roomByCode(code: string): Room | null {
    if (!isRoomCode(code)) return null;
    return this.rooms.get(normalizeRoomCode(code)) ?? null;
  }

  /** Public snapshot of a room, aligned with the wire `room:state` payload. */
  snapshot(room: Room): RoomSnapshot {
    return {
      code: room.code,
      status: statusOf(room),
      participants: [...room.participants.values()].map((participant) => ({
        id: participant.id,
        side: participant.side,
        status: "connected" as const,
        displayName: participant.displayName,
        language: participant.language,
      })),
    };
  }

  /**
   * Delete rooms that have sat at zero participants longer than the TTL.
   * Returns the swept codes so callers may log them.
   */
  sweepEmptyRooms(now: number = Date.now()): string[] {
    const swept: string[] = [];
    for (const [code, room] of this.rooms) {
      if (
        room.participants.size === 0 &&
        room.emptySince !== null &&
        now - room.emptySince >= EMPTY_ROOM_TTL_MS
      ) {
        this.rooms.delete(code);
        swept.push(code);
      }
    }
    return swept;
  }

  private findBySocket(room: Room, socketId: string): RoomParticipant | null {
    for (const participant of room.participants.values()) {
      if (participant.socketId === socketId) return participant;
    }
    return null;
  }
}

export function statusOf(room: Room): RoomStatus {
  return room.participants.size >= 2 ? "live" : "waiting";
}
