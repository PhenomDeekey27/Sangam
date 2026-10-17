/**
 * Primary/fallback orchestration for translation. The keyless, fast Google
 * endpoint (`GoogleTranslateUnofficialProvider`) fronts every utterance;
 * Gemini runs only when the primary fails. Sequential, never concurrent:
 * one provider is attempted first, the second only on failure, and nothing
 * retries indefinitely (at most one fallback attempt per utterance).
 *
 * Fallback policy:
 * - Primary 2xx + valid non-empty translation: returned immediately.
 * - Primary `unsupported`: rethrown with no fallback (Gemini shares the
 *   same language mapping and would refuse the identical pair).
 * - Any other primary failure (403, 429, 5xx, timeout, network error,
 *   malformed/empty/unverified-echo result): one Gemini attempt with the
 *   same text and language pair.
 * - Fallback disabled (`fallback: null`): the primary error propagates.
 * - Both fail: the fallback error propagates; the service keeps the
 *   original transcript and records a safe `failed` row.
 */
import {
  TranslationProviderError,
  type TranslationResult,
  type TranslationRequest,
  type Translator,
} from "./translator.js";

/** Which vendor handled one attempt. */
export type ChainProviderId = "google" | "gemini";

/** Safe per-attempt report: outcome and timing, never text or secrets. */
export interface ChainAttemptInfo {
  readonly provider: ChainProviderId;
  readonly ok: boolean;
  /** Failure code when `ok` is false. */
  readonly code?: string;
  /** Upstream HTTP status when the attempt made an HTTP round trip. */
  readonly httpStatus?: number | null;
  readonly elapsedMs: number;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
}

/** Safe final report: which provider supplied the translation, if any. */
export interface ChainFinalInfo {
  readonly provider: ChainProviderId | "none";
  readonly elapsedMs: number;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
}

export interface ChainedTranslatorOptions {
  /** Attempted first for every request. */
  readonly primary: Translator;
  /** Attempted once when the primary fails; `null` disables fallback. */
  readonly fallback: Translator | null;
  /** Safe per-attempt report hook (development diagnostics). */
  readonly onAttempt?: (info: ChainAttemptInfo) => void;
  /** Fired when the primary failed and the fallback is about to run. */
  readonly onFallbackStart?: () => void;
  /** Fired once per request with the provider that produced the result. */
  readonly onFinal?: (info: ChainFinalInfo) => void;
}

export class ChainedTranslator implements Translator {
  private readonly primary: Translator;
  private readonly fallback: Translator | null;
  private readonly onAttempt?: (info: ChainAttemptInfo) => void;
  private readonly onFallbackStart?: () => void;
  private readonly onFinal?: (info: ChainFinalInfo) => void;

  constructor(options: ChainedTranslatorOptions) {
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.onAttempt = options.onAttempt;
    this.onFallbackStart = options.onFallbackStart;
    this.onFinal = options.onFinal;
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    const startedAt = Date.now();
    const sourceLanguage = request.sourceLanguage;
    const targetLanguage = request.targetLanguage;
    const final = (provider: ChainProviderId | "none"): void => {
      try {
        this.onFinal?.({
          provider,
          elapsedMs: Date.now() - startedAt,
          sourceLanguage,
          targetLanguage,
        });
      } catch {
        // Diagnostics must never break translation.
      }
    };
    try {
      const result = await this.primary.translate(request);
      this.report({
        provider: "google",
        ok: true,
        elapsedMs: Date.now() - startedAt,
        sourceLanguage,
        targetLanguage,
      });
      final("google");
      return result;
    } catch (error) {
      const code = failureCode(error);
      const status = httpStatusOf(error);
      this.report({
        provider: "google",
        ok: false,
        code,
        httpStatus: status,
        elapsedMs: Date.now() - startedAt,
        sourceLanguage,
        targetLanguage,
      });
      if (code === "unsupported" || !this.fallback) {
        final("none");
        throw error;
      }
      try {
        this.onFallbackStart?.();
      } catch {
        // Diagnostics must never break translation.
      }
      const fallbackStartedAt = Date.now();
      try {
        const result = await this.fallback.translate(request);
        this.report({
          provider: "gemini",
          ok: true,
          elapsedMs: Date.now() - fallbackStartedAt,
          sourceLanguage,
          targetLanguage,
        });
        final("gemini");
        return result;
      } catch (fallbackError) {
        this.report({
          provider: "gemini",
          ok: false,
          code: failureCode(fallbackError),
          httpStatus: httpStatusOf(fallbackError),
          elapsedMs: Date.now() - fallbackStartedAt,
          sourceLanguage,
          targetLanguage,
        });
        final("none");
        throw fallbackError;
      }
    }
  }

  private report(info: ChainAttemptInfo): void {
    try {
      this.onAttempt?.(info);
    } catch {
      // Diagnostics must never break translation.
    }
  }
}

function failureCode(error: unknown): string {
  if (error instanceof TranslationProviderError) return error.code;
  return "unknown";
}

function httpStatusOf(error: unknown): number | null {
  if (error instanceof TranslationProviderError) return error.httpStatus;
  return null;
}
