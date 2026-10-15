import type { RoomCode } from "../types";

/** Length of every generated room code. */
export const ROOM_CODE_LENGTH = 6;

/**
 * Alphabet for room codes: uppercase letters and digits with ambiguous
 * characters (0/O, 1/I/L) removed, so codes survive being read aloud.
 */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Trim and uppercase a code pasted from a URL or shared by chat. */
export function normalizeRoomCode(value: string): RoomCode {
  return value.trim().toUpperCase();
}

/** Narrow a raw `/room/[code]` URL segment to a valid {@link RoomCode}. */
export function isRoomCode(value: string): value is RoomCode {
  const code = normalizeRoomCode(value);
  return (
    code.length === ROOM_CODE_LENGTH &&
    [...code].every((ch) => ROOM_CODE_ALPHABET.includes(ch))
  );
}

/**
 * Generate a new room code with the platform CSPRNG.
 * The alphabet size (32) divides 2^32, so byte-to-index mapping is unbiased.
 */
export function createRoomCode(): RoomCode {
  const bytes = new Uint32Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(
    bytes,
    (byte) => ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length],
  ).join("");
}
