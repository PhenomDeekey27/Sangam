import type { UtteranceId } from "@/features/conversation/types";
import { isValidUtteranceId } from "@/features/conversation/utils/utterance-id";
import { supportedLanguageOrNull } from "@/features/translation/data/languages";
import type {
  PlaybackUnavailablePayload,
  PlaybackUnavailableReason,
} from "@/types/socket";

/**
 * Validate an inbound `conversation:playback_unavailable` payload. The socket
 * is a network boundary, so a malformed frame is dropped before it can reach
 * the browser speech fallback (and speak the wrong text, or speak twice).
 */

const REASONS: readonly PlaybackUnavailableReason[] = [
  "provider_unavailable",
  "unsupported_language",
  "synthesis_failed",
  "audio_dropped",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSequence(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function isReason(value: unknown): value is PlaybackUnavailableReason {
  return (
    typeof value === "string" &&
    (REASONS as readonly string[]).includes(value)
  );
}

/** Validate one payload; `null` when anything is malformed. */
export function parsePlaybackUnavailablePayload(
  raw: unknown,
): PlaybackUnavailablePayload | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.utteranceId !== "string") return null;
  if (!isValidUtteranceId(raw.utteranceId as UtteranceId)) return null;
  if (!isSequence(raw.sequence)) return null;
  const language = supportedLanguageOrNull(raw.language);
  if (!language) return null;
  if (!isReason(raw.reason)) return null;
  return {
    utteranceId: raw.utteranceId as UtteranceId,
    sequence: raw.sequence,
    language,
    reason: raw.reason,
  };
}
