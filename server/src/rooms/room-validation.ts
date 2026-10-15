/**
 * Runtime validation for network input. TypeScript types do not validate
 * anything arriving over a socket, so every payload passes through here.
 *
 * The room-code rules intentionally mirror the frontend utility
 * (`src/features/room/utils/room-code.ts`) so the server stays deployable on
 * its own sources; `room-validation.test.ts` pins the shared behaviour.
 */

/** Length of every room code. */
export const ROOM_CODE_LENGTH = 6;

/**
 * Alphabet for room codes: uppercase letters and digits with ambiguous
 * characters (0/O, 1/I/L) removed, so codes survive being read aloud.
 */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Hard ceiling for a single relayed message (the composer caps at 280). */
export const MAX_TEXT_LENGTH = 1000;

/** Ceiling for a display name sent on join. */
export const MAX_DISPLAY_NAME_LENGTH = 24;

/** Ceiling for a language tag sent on join or with an utterance. */
const MAX_LANGUAGE_LENGTH = 16;

const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** Trim and uppercase a code pasted from a URL or shared by chat. */
export function normalizeRoomCode(value: string): string {
  return value.trim().toUpperCase();
}

/** Narrow a raw value to a well-formed room code. */
export function isRoomCode(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const code = normalizeRoomCode(value);
  return (
    code.length === ROOM_CODE_LENGTH &&
    [...code].every((ch) => ROOM_CODE_ALPHABET.includes(ch))
  );
}

/** Narrow a raw value to an acceptable language tag. */
export function isLanguageCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_LANGUAGE_LENGTH &&
    LANGUAGE_PATTERN.test(value)
  );
}

/**
 * Narrow a raw value to relayable message text: a non-empty string within
 * the size limit after trimming. Returns the trimmed text.
 */
export function sanitizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_TEXT_LENGTH) return null;
  return text;
}

/**
 * Narrow an optional display name. `ok.name` is `null` when the client sent
 * no usable name and the server should apply its default.
 */
export function sanitizeDisplayName(
  value: unknown,
):
  { readonly ok: true; readonly name: string | null } | { readonly ok: false } {
  if (value === undefined || value === null) {
    return { ok: true, name: null };
  }
  if (typeof value !== "string") return { ok: false };
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_DISPLAY_NAME_LENGTH) {
    return { ok: true, name: null };
  }
  return { ok: true, name };
}

/**
 * True when an object carries keys beyond the allowed set. Used to reject
 * payloads that try to smuggle a server-owned field (for example `side`).
 */
export function hasUnknownKeys(
  payload: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(payload).some((key) => !allowed.includes(key));
}

/** Fail-safe object guard: rejects null, arrays, and non-objects. */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
