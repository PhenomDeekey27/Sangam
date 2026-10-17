/**
 * Sarvam Mayura translation adapter (preferred provider).
 *
 * One documented REST round trip per utterance; the key travels only in the
 * `api-subscription-key` header and every failure is normalized into
 * `TranslationProviderError` so the chain can decide what to do next.
 *
 * Authoritative basis (docs.sarvam.ai, October 2026):
 * - `POST https://api.sarvam.ai/translate`, header `api-subscription-key`.
 * - body `{ input, source_language_code, target_language_code, model }` with
 *   regional BCP-47 codes (`"ta-IN"`) and model `mayura:v1`.
 * - response `{ translated_text, source_language_code }`; the translated text
 *   is echoed without quotation marks.
 *
 * Language coverage is Indic-only, so a non-Indic pair is refused locally with
 * an `unsupported` error — the chain then falls through to Google, which does
 * cover those languages. `mode` is left at its default and `numerals_format`
 * untouched so output stays plain text for both the transcript row and TTS.
 */
import { isLanguageCode, normalizeLanguage } from "../rooms/room-validation.js";
import { sarvamRequest, type SarvamFailure } from "../sarvam/http.js";
import {
  supportsSarvamTranslation,
  toSarvamLanguage,
} from "../sarvam/language-codes.js";
import {
  TranslationProviderError,
  type TranslationResult,
  type TranslationRequest,
  type Translator,
} from "./translator.js";

export const SARVAM_TRANSLATE_ENDPOINT = "https://api.sarvam.ai/translate";
export const SARVAM_DEFAULT_TRANSLATION_MODEL = "mayura:v1";
/** One translation must not outwait a conversation turn. */
const DEFAULT_TIMEOUT_MS = 20_000;

export interface SarvamTranslatorOptions {
  /** Sarvam API key. Stored server-side; never logged or emitted. */
  readonly apiKey: string;
  /** Model code; defaults to `mayura:v1`. */
  readonly model?: string | null;
  /** Override the endpoint (self-hosted proxies, tests). */
  readonly endpoint?: string | null;
  /** Per-request deadline in milliseconds. */
  readonly timeoutMs?: number;
  /** Injectable HTTP layer; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/** Map a normalized Sarvam failure onto the translator error contract. */
export function toTranslationError(failure: SarvamFailure): TranslationProviderError {
  switch (failure.kind) {
    case "auth":
      return new TranslationProviderError(
        "auth",
        "Sarvam translation rejected its credentials",
        failure.status,
      );
    case "rate_limited":
      return new TranslationProviderError(
        "rate_limited",
        "Sarvam translation quota or rate limit reached",
        failure.status,
      );
    case "timeout":
      return new TranslationProviderError(
        "timeout",
        "Sarvam translation timed out",
        failure.status,
      );
    case "rejected":
      // A rejected pair/body is treated as unsupported so the chain may try a
      // provider with a broader language catalog.
      return new TranslationProviderError(
        "unsupported",
        "Sarvam translation rejected the request",
        failure.status,
      );
    case "malformed":
      return new TranslationProviderError(
        "unknown",
        "Sarvam translation returned an unusable response",
        failure.status,
      );
    case "server":
    case "network":
      return new TranslationProviderError(
        "network",
        "Sarvam translation is unreachable",
        failure.status,
      );
  }
}

export class SarvamTranslator implements Translator {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SarvamTranslatorOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new Error("SarvamTranslator requires a non-empty apiKey");
    }
    this.apiKey = apiKey;
    this.model = options.model?.trim() || SARVAM_DEFAULT_TRANSLATION_MODEL;
    this.endpoint = options.endpoint?.trim() || SARVAM_TRANSLATE_ENDPOINT;
    this.timeoutMs =
      typeof options.timeoutMs === "number" && options.timeoutMs > 0
        ? Math.floor(options.timeoutMs)
        : DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    const source = normalizeLanguage(request.sourceLanguage ?? "");
    const target = normalizeLanguage(request.targetLanguage ?? "");
    // Local gate: Sarvam cannot serve a code it does not publish, and a
    // non-Indic pair must fall through to Google instead of being sent.
    if (
      !isLanguageCode(source) ||
      !isLanguageCode(target) ||
      !supportsSarvamTranslation(source) ||
      !supportsSarvamTranslation(target)
    ) {
      throw new TranslationProviderError(
        "unsupported",
        `Sarvam does not support ${source || "?"} -> ${target || "?"}`,
      );
    }
    const text = request.text?.trim() ?? "";
    if (text.length === 0) {
      throw new TranslationProviderError(
        "unsupported",
        "untranslatable text: empty",
      );
    }
    const result = await sarvamRequest({
      url: this.endpoint,
      apiKey: this.apiKey,
      body: JSON.stringify({
        input: text,
        source_language_code: toSarvamLanguage(source),
        target_language_code: toSarvamLanguage(target),
        model: this.model,
      }),
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
    if (!result.ok) throw toTranslationError(result.failure);
    const translated = readTranslatedText(result.body);
    if (translated === null || translated.length === 0) {
      throw new TranslationProviderError(
        "unknown",
        "Sarvam translation returned no usable text",
        result.status,
      );
    }
    return { text: translated, targetLanguage: target };
  }
}

/** Validate the documented response shape; `null` for anything unusable. */
export function readTranslatedText(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as { translated_text?: unknown };
  if (typeof record.translated_text !== "string") return null;
  return record.translated_text.trim();
}
