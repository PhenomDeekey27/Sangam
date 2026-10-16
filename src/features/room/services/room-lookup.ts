import { env } from "@/config/env";
import {
  partnerPreferences,
  type LanguagePreferences,
} from "@/features/room/utils/language-preference";
import { supportedLanguageOrNull } from "@/features/translation/data/languages";

/**
 * Code-only join lookup against the room server. The server stores the
 * creator's speaking/listening pair on seat `a`; this module fetches it and
 * mirrors it for the guest with the existing `partnerPreferences` helper —
 * the same mirror the invite link carries, never hardcoded languages.
 */

export interface RoomLookupReady {
  readonly status: "ready";
  /** The creator's stored pair (seat `a`). */
  readonly creator: LanguagePreferences;
  /** The mirrored pair the guest should start from. */
  readonly guest: LanguagePreferences;
  readonly seatsTaken: number;
}

export interface RoomLookupFailed {
  readonly status: "failed";
  readonly code: string;
  readonly message: string;
  /**
   * `true` when joining now is pointless (unknown, malformed, or full room)
   * and the UI should block with this message. `false` for transport-level
   * failures, where the validated `room:join` round trip stays authoritative.
   */
  readonly blocking: boolean;
}

export type RoomLookup = RoomLookupReady | RoomLookupFailed;

interface LookupBody {
  readonly ok?: unknown;
  readonly code?: unknown;
  readonly language?: unknown;
  readonly listeningLanguage?: unknown;
  readonly seatsTaken?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

function serverError(body: LookupBody | null, fallback: string): RoomLookup {
  const code =
    typeof body?.error?.code === "string" ? body.error.code : "lookup_failed";
  const message =
    typeof body?.error?.message === "string" && body.error.message.length > 0
      ? body.error.message
      : fallback;
  // The server's own membership verdicts are final; anything else may be
  // transient, so the join attempt itself remains the authority there.
  const blocking =
    code === "invalid_code" ||
    code === "room_not_found" ||
    code === "room_full";
  return { status: "failed", code, message, blocking };
}

/**
 * Fetch the creator's stored preferences for a room code. Returns the mirrored
 * guest pair on success; on failure returns a display-ready error that says
 * whether the UI should block the join or let the `room:join` round trip
 * decide.
 */
export async function fetchRoomLookup(
  code: string,
  signal?: AbortSignal,
): Promise<RoomLookup> {
  let response: Response;
  try {
    response = await fetch(
      `${env.socketUrl}/api/rooms/${encodeURIComponent(code)}`,
      { signal },
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    return {
      status: "failed",
      code: "lookup_unavailable",
      message:
        "Could not reach the room server to look up its languages — you can still join with the languages below.",
      blocking: false,
    };
  }
  let body: LookupBody | null = null;
  try {
    body = (await response.json()) as LookupBody;
  } catch {
    body = null;
  }
  if (!response.ok || body?.ok !== true) {
    return serverError(body, "Could not look up this room's languages.");
  }
  const speaking = supportedLanguageOrNull(body?.language);
  const listening = supportedLanguageOrNull(body?.listeningLanguage);
  const seatsTaken =
    typeof body?.seatsTaken === "number" ? body.seatsTaken : Number.NaN;
  if (!speaking || !listening || Number.isNaN(seatsTaken)) {
    return {
      status: "failed",
      code: "lookup_invalid",
      message:
        "The room server returned unreadable languages — you can still join with the languages below.",
      blocking: false,
    };
  }
  const creator: LanguagePreferences = { speaking, listening };
  return {
    status: "ready",
    creator,
    guest: partnerPreferences(creator),
    seatsTaken,
  };
}
