/**
 * Build the configured machine-translation chain. Kept separate from the
 * vendors themselves so the rest of the server depends on the `Translator`
 * interface, never on a concrete API.
 *
 * Order is fixed: Sarvam Mayura (when configured) fronts every utterance, the
 * keyless Google endpoint covers its failures, and Gemini (when configured)
 * covers Google's. A `null` translator keeps every utterance at
 * `translation: unavailable` — the no-provider behavior.
 */
import { GeminiTranslator } from "./gemini-provider.js";
import {
  GoogleTranslateUnofficialProvider,
  type GoogleProviderEvent,
} from "./google-translate-provider.js";
import { SarvamTranslator } from "./sarvam-provider.js";
import {
  ChainedTranslator,
  createTranslationChain,
  type ChainAttemptInfo,
  type ChainFinalInfo,
  type ChainMember,
  type ChainProviderId,
} from "./translation-chain.js";
import type { TranslationEnv } from "../config/env.js";
import type { Translator } from "./translator.js";

/** Bounded Gemini budget inside the chain: the primary owns the fast path. */
const FALLBACK_TIMEOUT_MS = 15_000;

/** Optional safe diagnostics plumbing (development use, never transcript). */
export interface TranslationHooks {
  readonly onAttempt?: (info: ChainAttemptInfo) => void;
  readonly onFallbackStart?: (next: ChainProviderId) => void;
  readonly onFinal?: (info: ChainFinalInfo) => void;
  readonly onPrimaryEvent?: (event: GoogleProviderEvent) => void;
}

/**
 * Resolve the configured translator, or `null` when translation is
 * unavailable. Keys are validated by `resolveTranslationEnv`, so a configured
 * provider always carries credentials here.
 */
export function createTranslator(
  translation: TranslationEnv,
  hooks?: TranslationHooks,
): Translator | null {
  if (!translation.primary) return null;
  const google = new GoogleTranslateUnofficialProvider({
    onEvent: hooks?.onPrimaryEvent,
  });
  const gemini =
    translation.fallback === "gemini" && translation.apiKey
      ? new GeminiTranslator({
          apiKey: translation.apiKey,
          model: translation.model,
          timeoutMs: FALLBACK_TIMEOUT_MS,
        })
      : null;

  if (translation.primary === "sarvam") {
    if (!translation.sarvamApiKey) return null;
    // Sarvam → Google → Gemini. Sarvam's Indic-only gap falls through to
    // Google (stopOnUnsupported: false); Google's own gap still aborts, since
    // Gemini shares its mapping.
    const members: ChainMember[] = [
      {
        id: "sarvam",
        translator: new SarvamTranslator({
          apiKey: translation.sarvamApiKey,
          model: translation.sarvamModel,
        }),
        stopOnUnsupported: false,
      },
      { id: "google", translator: google, stopOnUnsupported: true },
    ];
    if (gemini) {
      members.push({ id: "gemini", translator: gemini, stopOnUnsupported: true });
    }
    return createTranslationChain({
      members,
      onAttempt: hooks?.onAttempt,
      onFallbackStart: hooks?.onFallbackStart,
      onFinal: hooks?.onFinal,
    });
  }

  // Google primary (its failures fall to Gemini when configured).
  if (!gemini) return google;
  return new ChainedTranslator({
    primary: google,
    fallback: gemini,
    onAttempt: hooks?.onAttempt,
    onFallbackStart: hooks?.onFallbackStart,
    onFinal: hooks?.onFinal,
  });
}
