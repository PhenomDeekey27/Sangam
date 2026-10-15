/**
 * Structured error vocabulary shared by acks and the `error` event.
 * Codes are stable machine identifiers; messages are safe to show in a UI.
 * (The spec names this channel `room:error`; the existing wire contract in
 * `src/types/socket.ts` calls it `error` — same payload shape, mapped 1:1.)
 */
export const ErrorCodes = {
  ROOM_NOT_FOUND: "room_not_found",
  ROOM_ALREADY_EXISTS: "room_already_exists",
  ROOM_FULL: "room_full",
  INVALID_CODE: "invalid_code",
  INVALID_PAYLOAD: "invalid_payload",
  NOT_IN_ROOM: "not_in_room",
  INTERNAL: "internal_error",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** Uniform wire shape for failures, mirrored in `src/types/socket.ts`. */
export interface WireError {
  readonly code: ErrorCode | string;
  readonly message: string;
}

export function wireError(code: ErrorCode, message: string): WireError {
  return { code, message };
}

const MESSAGES: Record<ErrorCode, string> = {
  room_not_found:
    "That room does not exist. It may have expired — ask your partner for a fresh code.",
  room_already_exists: "That room code is already in use.",
  room_full: "That room already has two participants.",
  invalid_code: "Malformed room code.",
  invalid_payload: "Malformed event payload.",
  not_in_room: "You are not a member of that room.",
  internal_error: "The server hit an unexpected problem.",
};

export function messageFor(code: ErrorCode): string {
  return MESSAGES[code];
}

/** Build a WireError with the canonical message for a code. */
export function errorFor(code: ErrorCode): WireError {
  return wireError(code, MESSAGES[code]);
}
