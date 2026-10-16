import { ErrorCodes, errorFor, type WireError } from "../utils/errors.js";
import { isRoomCode, normalizeRoomCode } from "./room-validation.js";
import type { RoomManager } from "./room-manager.js";

/**
 * Code-only join lookup. Person B pastes just the six-character room code,
 * so the join dialog asks the server — the source of truth for who speaks
 * what — for the creator's stored preferences and mirrors them for the guest.
 * The response carries only two language codes and a seat count: no
 * identities, no transcripts, nothing the invite link does not already
 * expose publicly.
 */
export interface RoomLookupSuccess {
  readonly ok: true;
  readonly code: string;
  /** Seat `a` (the creator) speaking language. */
  readonly language: string;
  /** Seat `a` (the creator) listening language. */
  readonly listeningLanguage: string;
  /** Seats currently occupied (0–2); 2 means Person B cannot join. */
  readonly seatsTaken: number;
}

export type RoomLookupResult =
  | RoomLookupSuccess
  | { readonly ok: false; readonly error: WireError; readonly status: number };

/**
 * Look up a room for a code-only join. The creator always sits on side `a`
 * (`createAndJoin` seats `a` first), so seat `a` is the mirrored source.
 * A room with no creator seat (never existed, swept after expiry, or left
 * empty) reports `room_not_found`; a room with both seats taken reports
 * `room_full`. Language preferences are never invented here.
 */
export function lookupRoomForJoin(
  rooms: RoomManager,
  rawCode: unknown,
): RoomLookupResult {
  if (!isRoomCode(rawCode)) {
    return {
      ok: false,
      error: errorFor(ErrorCodes.INVALID_CODE),
      status: 400,
    };
  }
  const room = rooms.roomByCode(normalizeRoomCode(rawCode));
  if (!room) {
    return {
      ok: false,
      error: errorFor(ErrorCodes.ROOM_NOT_FOUND),
      status: 404,
    };
  }
  if (room.participants.size >= 2) {
    return {
      ok: false,
      error: errorFor(ErrorCodes.ROOM_FULL),
      status: 409,
    };
  }
  const creator = room.participants.get("a");
  if (!creator) {
    return {
      ok: false,
      error: errorFor(ErrorCodes.ROOM_NOT_FOUND),
      status: 404,
    };
  }
  return {
    ok: true,
    code: room.code,
    language: creator.language,
    listeningLanguage: creator.listeningLanguage,
    seatsTaken: room.participants.size,
  };
}
