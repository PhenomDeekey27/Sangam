import type { UtteranceId } from "@/features/conversation/types";
import { isValidUtteranceId } from "@/features/conversation/utils/utterance-id";
import { supportedLanguageOrNull } from "@/features/translation/data/languages";
import type { PlaybackPayload } from "@/types/socket";

/**
 * Validate an inbound `conversation:playback` payload. The server is ours,
 * but the socket is still a network boundary: malformed or oversized labels
 * are dropped so a bad frame can never corrupt the playback queue. The audio
 * bytes themselves are validated against the reported MIME type in the
 * player, not here.
 */

const ALLOWED_MIME_PREFIXES = ["audio/", "application/ogg"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAllowedMimeType(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const base = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return (ALLOWED_MIME_PREFIXES as readonly string[]).some((prefix) =>
    base.startsWith(prefix),
  );
}

/** True for finite, positive, integer ordering stamps. */
function isSequence(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER
  );
}

/** Validate one playback event payload; `null` when anything is malformed. */
export function parsePlaybackPayload(raw: unknown): PlaybackPayload | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.utteranceId !== "string") return null;
  if (!isValidUtteranceId(raw.utteranceId as UtteranceId)) return null;
  if (!isSequence(raw.sequence)) return null;
  const language = supportedLanguageOrNull(raw.language);
  if (!language) return null;
  if (!isAllowedMimeType(raw.mimeType)) return null;
  return {
    utteranceId: raw.utteranceId,
    sequence: raw.sequence,
    language,
    mimeType: (raw.mimeType as string).split(";")[0]!.trim().toLowerCase(),
  };
}
