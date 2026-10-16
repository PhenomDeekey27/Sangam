/**
 * Language preferences travel in room URLs and over the socket. This module is
 * the single place that names the query parameters and validates their values,
 * so the landing screen, the invite sheet, and the room route can never drift
 * apart (a mismatch there is what silently loses a participant's language).
 *
 * A participant has two independent preferences:
 * - `speaking`  — the language they talk in; drives their own recognition.
 * - `listening` — the language they want to hear (translation target later).
 */
import { roomPath } from "@/features/room/utils/room-path";
import {
  DEFAULT_LISTENING_LANGUAGE,
  DEFAULT_SPEAKING_LANGUAGE,
  supportedLanguageOrNull,
} from "@/features/translation/data/languages";
import type { RoomCode } from "@/features/room/types";
import type { LanguageCode } from "@/types";

/** Query parameter carrying "the language I speak". */
export const SPEAKING_PARAM = "speak";
/** Query parameter carrying "the language I want to hear". */
export const LISTENING_PARAM = "hear";

/** One participant's pair of preferences. */
export interface LanguagePreferences {
  readonly speaking: LanguageCode;
  readonly listening: LanguageCode;
}

/** A raw query value as Next.js hands it over. */
export type LanguageParam = string | readonly string[] | undefined | null;

/**
 * Resolve one raw parameter to a supported language. Missing, empty, malformed,
 * or unsupported values fall back; a valid selection always survives (case and
 * whitespace are normalized, never discarded).
 */
export function resolveLanguage(
  value: LanguageParam,
  fallback: LanguageCode,
): LanguageCode {
  const candidate = Array.isArray(value) ? value[0] : value;
  return supportedLanguageOrNull(candidate) ?? fallback;
}

/**
 * Read both preferences out of a URL query. A missing or invalid parameter
 * yields the default for that half only; the other half is untouched.
 */
export function readLanguagePreferences(
  query: Readonly<Record<string, LanguageParam>>,
): LanguagePreferences {
  return {
    speaking: resolveLanguage(query[SPEAKING_PARAM], DEFAULT_SPEAKING_LANGUAGE),
    listening: resolveLanguage(
      query[LISTENING_PARAM],
      DEFAULT_LISTENING_LANGUAGE,
    ),
  };
}

/**
 * Query string (no leading `?`) that carries these preferences. Only language
 * codes are written — never a display name, room membership, or any secret.
 */
export function languageQuery(preferences: LanguagePreferences): string {
  const params = new URLSearchParams({
    [SPEAKING_PARAM]: preferences.speaking,
    [LISTENING_PARAM]: preferences.listening,
  });
  return params.toString();
}

/**
 * The same two people seen from the other side: the partner speaks what you
 * want to hear and hears what you speak. Used to build an invite link that
 * carries the partner's preferences before they have an account or a seat.
 */
export function partnerPreferences(
  preferences: LanguagePreferences,
): LanguagePreferences {
  return {
    speaking: preferences.listening,
    listening: preferences.speaking,
  };
}

/**
 * Invite link for a room: your own preferences mirrored for the partner, so
 * the URL they open resolves to the languages they are meant to use. The link
 * carries only the room code and two language codes — no identities, no
 * secrets, and nothing the server owns.
 */
export function roomInvitePath(
  code: RoomCode,
  preferences: LanguagePreferences,
): string {
  return `${roomPath(code)}?${languageQuery(partnerPreferences(preferences))}`;
}

/** Preferences from a raw room URL, with both halves validated. */
export function preferencesFromSearch(search: string): LanguagePreferences {
  return readLanguagePreferences(
    Object.fromEntries(new URLSearchParams(search)) as Record<
      string,
      LanguageParam
    >,
  );
}
