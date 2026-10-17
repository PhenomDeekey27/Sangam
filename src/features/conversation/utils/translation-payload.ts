import type { UtteranceId } from "@/features/conversation/types";
import { isValidUtteranceId } from "@/features/conversation/utils/utterance-id";
import type {
  TranslationErrorCode,
  TranslationState,
} from "@/features/translation/types";
import { supportedLanguageOrNull } from "@/features/translation/data/languages";

/**
 * Validate an inbound `conversation:translation` payload. The server is ours,
 * but the socket is still a network boundary: malformed updates are dropped
 * so a bad row can never corrupt the transcript. Only terminal states are
 * accepted — the client never invents `queued`/`translating` rows.
 */

const MAX_TRANSLATION_TEXT_LENGTH = 5000;
const MAX_ERROR_MESSAGE_LENGTH = 500;

const ERROR_CODES: ReadonlySet<string> = new Set([
  "network",
  "timeout",
  "provider_error",
  "unsupported_language",
  "unknown",
]);

export interface TranslationUpdate {
  readonly utteranceId: UtteranceId;
  readonly translation: TranslationState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0 || text.length > max) return null;
  return text;
}

function parseTranslation(value: unknown): TranslationState | null {
  if (!isRecord(value)) return null;
  if (value.status === "complete") {
    const text = cleanText(value.text, MAX_TRANSLATION_TEXT_LENGTH);
    const targetLanguage = supportedLanguageOrNull(value.targetLanguage);
    if (!text || !targetLanguage) return null;
    return { status: "complete", text, targetLanguage };
  }
  if (value.status === "failed") {
    if (!isRecord(value.error)) return null;
    const rawCode = value.error.code;
    const code: TranslationErrorCode =
      typeof rawCode === "string" && ERROR_CODES.has(rawCode)
        ? (rawCode as TranslationErrorCode)
        : "unknown";
    const message = cleanText(value.error.message, MAX_ERROR_MESSAGE_LENGTH);
    if (!message) return null;
    return { status: "failed", error: { code, message } };
  }
  return null;
}

export function parseTranslationUpdate(raw: unknown): TranslationUpdate | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.utteranceId !== "string") return null;
  if (!isValidUtteranceId(raw.utteranceId)) return null;
  const translation = parseTranslation(raw.translation);
  if (!translation) return null;
  return { utteranceId: raw.utteranceId, translation };
}
