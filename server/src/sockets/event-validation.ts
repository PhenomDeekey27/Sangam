import { ErrorCodes, errorFor, type WireError } from "../utils/errors.js";
import {
  MAX_TEXT_LENGTH,
  hasUnknownKeys,
  isLanguageCode,
  isPlainObject,
  isRoomCode,
  normalizeRoomCode,
  sanitizeDisplayName,
  sanitizeText,
} from "../rooms/room-validation.js";
import type { SocketError } from "./contract.js";

/** Result of validating one inbound payload. */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SocketError };

/** Client fields accepted on join/create; anything else is rejected. */
export const JOIN_KEYS = ["code", "language", "displayName"] as const;
/** Client fields accepted on leave. */
export const LEAVE_KEYS = ["code"] as const;
/** Client fields accepted on an utterance; `side`/`id` are never accepted. */
export const UTTERANCE_KEYS = ["utteranceId", "text", "language"] as const;
/** Client fields accepted on an interim line. */
export const INTERIM_KEYS = ["text", "language"] as const;

/** Bounds for a client-generated utterance id (mirrors the client utility). */
export const MIN_UTTERANCE_ID_LENGTH = 8;
export const MAX_UTTERANCE_ID_LENGTH = 64;

const UTTERANCE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface JoinPayload {
  readonly code: string;
  readonly language: string;
  readonly displayName: string | null;
}

function fail(error: WireError): ParseResult<never> {
  return { ok: false, error };
}

/**
 * Narrow a raw value to an acceptable client-generated utterance id: opaque
 * characters only, bounded length. Uniqueness within a room is the caller's
 * responsibility (see `room-handlers.ts`).
 */
export function isUtteranceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= MIN_UTTERANCE_ID_LENGTH &&
    value.length <= MAX_UTTERANCE_ID_LENGTH &&
    UTTERANCE_ID_PATTERN.test(value)
  );
}

/**
 * Narrow a raw value to relayable interim text: a string within the size
 * limit after trimming. Empty is allowed — it is the clear-line signal.
 */
export function sanitizeInterimText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length > MAX_TEXT_LENGTH) return null;
  return text;
}

/**
 * Validate a `room:create` / `room:join` payload. Unknown keys (for example a
 * client-tried `side` or `participantId`) fail validation outright, which is
 * how impersonation attempts are rejected.
 */
export function parseJoinPayload(raw: unknown): ParseResult<JoinPayload> {
  if (!isPlainObject(raw)) return fail(errorFor(ErrorCodes.INVALID_PAYLOAD));
  if (hasUnknownKeys(raw, JOIN_KEYS)) {
    return fail(errorFor(ErrorCodes.INVALID_PAYLOAD));
  }
  if (!isRoomCode(raw.code)) return fail(errorFor(ErrorCodes.INVALID_CODE));
  if (!isLanguageCode(raw.language)) {
    return fail(errorFor(ErrorCodes.INVALID_PAYLOAD));
  }
  const displayName = sanitizeDisplayName(raw.displayName);
  if (!displayName.ok) return fail(errorFor(ErrorCodes.INVALID_PAYLOAD));
  return {
    ok: true,
    value: {
      code: normalizeRoomCode(raw.code),
      language: raw.language,
      displayName: displayName.name,
    },
  };
}

/**
 * Validate a `room:leave` payload. The code must match the socket's current
 * membership (supplied by the caller), so a client cannot probe other codes.
 */
export function parseLeavePayload(
  raw: unknown,
  membershipCode: string,
): ParseResult<{ readonly code: string }> {
  if (!isPlainObject(raw)) return fail(errorFor(ErrorCodes.INVALID_PAYLOAD));
  if (hasUnknownKeys(raw, LEAVE_KEYS)) {
    return fail(errorFor(ErrorCodes.INVALID_PAYLOAD));
  }
  if (!isRoomCode(raw.code)) return fail(errorFor(ErrorCodes.INVALID_CODE));
  const code = normalizeRoomCode(raw.code);
  if (code !== membershipCode) {
    return fail(errorFor(ErrorCodes.NOT_IN_ROOM));
  }
  return { ok: true, value: { code } };
}

/**
 * Validate a `conversation:utterance` payload; returns the client-generated
 * id plus trimmed text and language.
 */
export function parseUtterancePayload(raw: unknown): ParseResult<{
  readonly utteranceId: string;
  readonly text: string;
  readonly language: string;
}> {
  if (!isPlainObject(raw)) return fail(errorFor(ErrorCodes.INVALID_PAYLOAD));
  if (hasUnknownKeys(raw, UTTERANCE_KEYS)) {
    return fail(errorFor(ErrorCodes.INVALID_PAYLOAD));
  }
  if (!isUtteranceId(raw.utteranceId)) {
    return fail(errorFor(ErrorCodes.INVALID_PAYLOAD));
  }
  if (!isLanguageCode(raw.language)) {
    return fail(errorFor(ErrorCodes.INVALID_PAYLOAD));
  }
  const text = sanitizeText(raw.text);
  if (text === null) return fail(errorFor(ErrorCodes.INVALID_PAYLOAD));
  return {
    ok: true,
    value: { utteranceId: raw.utteranceId, text, language: raw.language },
  };
}

/**
 * Validate a `conversation:interim` payload. Interim text may be empty (the
 * clear-line signal) but must never exceed the relayed-text limit.
 */
export function parseInterimPayload(
  raw: unknown,
): ParseResult<{ readonly text: string; readonly language: string }> {
  if (!isPlainObject(raw)) return fail(errorFor(ErrorCodes.INVALID_PAYLOAD));
  if (hasUnknownKeys(raw, INTERIM_KEYS)) {
    return fail(errorFor(ErrorCodes.INVALID_PAYLOAD));
  }
  if (!isLanguageCode(raw.language)) {
    return fail(errorFor(ErrorCodes.INVALID_PAYLOAD));
  }
  const text = sanitizeInterimText(raw.text);
  if (text === null) return fail(errorFor(ErrorCodes.INVALID_PAYLOAD));
  return { ok: true, value: { text, language: raw.language } };
}
