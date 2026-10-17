/**
 * Ordered orchestration for translation. One vendor is attempted first; every
 * later member is tried only when the earlier one fails, sequentially and
 * never concurrently (at most one attempt per member per utterance).
 *
 * The default Sangam order is Google → Gemini; the Sarvam integration inserts
 * Sarvam ahead of Google (Sarvam → Google → Gemini) when its key is present.
 *
 * Fallback policy, per member:
 * - A 2xx + valid non-empty translation is returned immediately.
 * - A member marked `stopOnUnsupported` that fails with `unsupported` stops
 *   the chain: later members share the same language mapping and would refuse
 *   the identical pair. Google carries that flag (Gemini shares its mapping);
 *   Sarvam does not, so an Indic-only gap falls through to Google.
 * - Any other failure (403, 429, 5xx, timeout, network, malformed/empty/
 *   unverified-echo result) moves on to the next member.
 * - The last member's error propagates; the service keeps the original
 *   transcript and records a safe `failed` row.
 */
import {
  TranslationProviderError,
  type TranslationResult,
  type TranslationRequest,
  type Translator,
} from "./translator.js";

/** Which vendor handled one attempt. */
export type ChainProviderId = "sarvam" | "google" | "gemini";

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

/** One ordered attempt in a translation chain. */
export interface ChainMember {
  readonly id: ChainProviderId;
  readonly translator: Translator;
  /**
   * When true, an `unsupported` failure from this member ends the chain
   * instead of moving to the next one (its language mapping is shared).
   */
  readonly stopOnUnsupported?: boolean;
}

/** Shared diagnostics plumbing for both chain constructors. */
export interface ChainHooks {
  /** Safe per-attempt report hook (development diagnostics). */
  readonly onAttempt?: (info: ChainAttemptInfo) => void;
  /** Fired when a member failed and the next one is about to run. */
  readonly onFallbackStart?: (next: ChainProviderId) => void;
  /** Fired once per request with the provider that produced the result. */
  readonly onFinal?: (info: ChainFinalInfo) => void;
}

export interface TranslatorChainOptions extends ChainHooks {
  /** Attempted in order until one succeeds. Must be non-empty. */
  readonly members: readonly ChainMember[];
}

export interface ChainedTranslatorOptions extends ChainHooks {
  /** Attempted first for every request. */
  readonly primary: Translator;
  /** Attempted once when the primary fails; `null` disables fallback. */
  readonly fallback: Translator | null;
  /** Reported id of the primary; defaults to `google`. */
  readonly primaryId?: ChainProviderId;
  /** Reported id of the fallback; defaults to `gemini`. */
  readonly fallbackId?: ChainProviderId;
  /**
   * When true, an `unsupported` primary failure falls through to the fallback
   * instead of aborting. Defaults to false (the Google→Gemini rule).
   */
  readonly fallbackOnUnsupported?: boolean;
}

/** The one implementation of the ordered-attempt loop. */
class ChainRunner {
  constructor(
    private readonly members: readonly ChainMember[],
    private readonly hooks: ChainHooks,
  ) {}

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    const startedAt = Date.now();
    const sourceLanguage = request.sourceLanguage;
    const targetLanguage = request.targetLanguage;
    const final = (provider: ChainProviderId | "none"): void => {
      try {
        this.hooks.onFinal?.({
          provider,
          elapsedMs: Date.now() - startedAt,
          sourceLanguage,
          targetLanguage,
        });
      } catch {
        // Diagnostics must never break translation.
      }
    };
    for (let index = 0; index < this.members.length; index += 1) {
      const member = this.members[index] as ChainMember;
      const attemptStartedAt = Date.now();
      try {
        const result = await member.translator.translate(request);
        this.report({
          provider: member.id,
          ok: true,
          elapsedMs: Date.now() - attemptStartedAt,
          sourceLanguage,
          targetLanguage,
        });
        final(member.id);
        return result;
      } catch (error) {
        const code = failureCode(error);
        this.report({
          provider: member.id,
          ok: false,
          code,
          httpStatus: httpStatusOf(error),
          elapsedMs: Date.now() - attemptStartedAt,
          sourceLanguage,
          targetLanguage,
        });
        const isLast = index === this.members.length - 1;
        if (isLast || (code === "unsupported" && member.stopOnUnsupported)) {
          final("none");
          throw error;
        }
        try {
          this.hooks.onFallbackStart?.(
            (this.members[index + 1] as ChainMember).id,
          );
        } catch {
          // Diagnostics must never break translation.
        }
      }
    }
    // Unreachable: a non-empty member list always returns or throws.
    final("none");
    throw new TranslationProviderError("unknown", "translation chain is empty");
  }

  private report(info: ChainAttemptInfo): void {
    try {
      this.hooks.onAttempt?.(info);
    } catch {
      // Diagnostics must never break translation.
    }
  }
}

export class ChainedTranslator implements Translator {
  private readonly runner: ChainRunner;

  constructor(options: ChainedTranslatorOptions) {
    const members: ChainMember[] = [
      {
        id: options.primaryId ?? "google",
        translator: options.primary,
        stopOnUnsupported: !options.fallbackOnUnsupported,
      },
      ...(options.fallback
        ? [
            {
              id: options.fallbackId ?? "gemini",
              translator: options.fallback,
              stopOnUnsupported: true,
            },
          ]
        : []),
    ];
    this.runner = new ChainRunner(members, options);
  }

  translate(request: TranslationRequest): Promise<TranslationResult> {
    return this.runner.translate(request);
  }
}

/**
 * Build a chain from an explicit ordered member list. A single member is
 * returned untouched so its behavior and diagnostics are unchanged.
 */
export function createTranslationChain(
  options: TranslatorChainOptions,
): Translator {
  const members = options.members;
  if (members.length === 0) {
    throw new Error("createTranslationChain requires at least one member");
  }
  if (members.length === 1) return (members[0] as ChainMember).translator;
  const runner = new ChainRunner(members, options);
  return {
    translate: (request) => runner.translate(request),
  };
}

function failureCode(error: unknown): string {
  if (error instanceof TranslationProviderError) return error.code;
  return "unknown";
}

function httpStatusOf(error: unknown): number | null {
  if (error instanceof TranslationProviderError) return error.httpStatus;
  return null;
}
