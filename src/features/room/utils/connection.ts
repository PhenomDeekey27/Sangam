import type { SocketError } from "@/types/socket";

/**
 * Reconnect policy for the room screen: pure decisions about the
 * transport-vs-membership lifecycle, kept out of the socket hook so they are
 * unit-testable without a server.
 *
 * A connected Socket.IO transport is NOT room membership. `connected` is
 * reported only after the server's join/create acknowledgement AND the room
 * snapshot that names this participant's seat. A `room_not_found` reply for
 * a socket that was previously seated means the in-memory room is gone
 * (backend restart, expiry, or sweep) — never a cue to invent a replacement
 * room or to retry forever.
 */

/** Machine-readable marker for a room that is gone after membership. */
export const ROOM_EXPIRED_CODE = "room_expired";

/** Shown when a previously joined room no longer exists server-side. */
export const ROOM_EXPIRED_MESSAGE =
  "This conversation ended because the server restarted. Please create a new room.";

/** How long a create/join round trip may go unanswered before retrying. */
export const ROOM_JOIN_TIMEOUT_MS = 10_000;

/**
 * Whether a failed join means the room this client belonged to is gone.
 * Only a previous member can make that claim: a fresh join that finds no
 * room keeps the server's generic message (it may simply be a wrong code).
 */
export function shouldTreatAsExpired(
  wasMember: boolean,
  errorCode: string,
): boolean {
  return wasMember && errorCode === "room_not_found";
}

/** The terminal error for a room lost after membership. */
export function expiredRoomError(): SocketError {
  return { code: ROOM_EXPIRED_CODE, message: ROOM_EXPIRED_MESSAGE };
}

/**
 * Session storage when one exists (browser tab, jsdom harness), else `null`.
 * Never throws: private mode and server runtimes degrade to no memory.
 */
function sessionStore(): Storage | null {
  try {
    const scope = globalThis as unknown as {
      readonly window?: { readonly sessionStorage?: unknown };
      readonly sessionStorage?: unknown;
    };
    const candidate =
      scope.window?.sessionStorage ?? scope.sessionStorage ?? null;
    if (
      candidate !== null &&
      typeof (candidate as Storage).getItem === "function" &&
      typeof (candidate as Storage).setItem === "function"
    ) {
      return candidate as Storage;
    }
    return null;
  } catch {
    return null;
  }
}

/** Session-storage key recording confirmed membership of one room code. */
export function memberStorageKey(code: string): string {
  return `sangam:was-member:${code}`;
}

/**
 * Whether this browser profile was ever seated in `code`. Survives refresh
 * (session storage); a separate profile never shares it, so a genuinely new
 * guest still gets the generic unknown-room message.
 */
export function readWasMember(code: string): boolean {
  try {
    return sessionStore()?.getItem(memberStorageKey(code)) === "1";
  } catch {
    return false;
  }
}

/** Record confirmed membership; best-effort (private mode must not throw). */
export function markWasMember(code: string): void {
  try {
    sessionStore()?.setItem(memberStorageKey(code), "1");
  } catch {
    // Membership still works; only the restart message degrades.
  }
}
