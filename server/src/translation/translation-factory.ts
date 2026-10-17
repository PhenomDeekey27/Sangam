/**
 * Build the configured machine-translation vendor. Kept separate from the
 * vendors themselves so the rest of the server depends on the `Translator`
 * interface, never on a concrete API.
 *
 * Order is fixed: the keyless Google endpoint fronts every utterance and
 * Gemini (when configured) covers its failures. A `null` translator keeps
 * every utterance at `translation: unavailable` — the no-provider behavior.
 */
import { GeminiTranslator } from "./gemini-provider.js";
import {
  GoogleTranslateUnofficialProvider,
  type GoogleProviderEvent,
} from "./google-translate-provider.js";
import {
  ChainedTranslator,
  type ChainAttemptInfo,
  type ChainFinalInfo,
} from "./translation-chain.js";
import type { TranslationEnv } from "../config/env.js";
import type { Translator } from "./translator.js";

/** Bounded Gemini budget inside the chain: the primary owns the fast path. */
const FALLBACK_TIMEOUT_MS = 15_000;

/** Optional safe diagnostics plumbing (development use, never transcript). */
export interface TranslationHooks {
  readonly onAttempt?: (info: ChainAttemptInfo) => void;
  readonly onFallbackStart?: () => void;
  readonly onFinal?: (info: ChainFinalInfo) => void;
  readonly onPrimaryEvent?: (event: GoogleProviderEvent) => void;
}

/**
 * Resolve the configured translator, or `null` when translation is
 * unavailable. The Gemini key is validated by `resolveTranslationEnv`, so a
 * configured fallback always carries credentials here.
 */
export function createTranslator(
  translation: TranslationEnv,
  hooks?: TranslationHooks,
): Translator | null {
  if (!translation.primary) return null;
  const primary = new GoogleTranslateUnofficialProvider({
    onEvent: hooks?.onPrimaryEvent,
  });
  if (translation.fallback === "gemini") {
    if (!translation.apiKey) return primary;
    return new ChainedTranslator({
      primary,
      fallback: new GeminiTranslator({
        apiKey: translation.apiKey,
        model: translation.model,
        timeoutMs: FALLBACK_TIMEOUT_MS,
      }),
      onAttempt: hooks?.onAttempt,
      onFallbackStart: hooks?.onFallbackStart,
      onFinal: hooks?.onFinal,
    });
  }
  return primary;
}
