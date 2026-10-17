/**
 * Build the configured speech provider (or chain). Kept separate from the
 * providers themselves so the rest of the server depends on the interface,
 * never on a concrete vendor.
 *
 * Priority, resolved from validated config:
 *   Sarvam Saaras (`saaras:v4`) → Deepgram Nova-3 → unconfigured.
 * Sarvam receives the Deepgram provider as its internal fallback, so a failed
 * Sarvam turn is replayed once through Deepgram instead of being lost.
 */
import type { SpeechProvider } from "./provider.js";
import { createMockSpeechProvider } from "./mock-provider.js";
import { createDeepgramSpeechProvider } from "./deepgram-provider.js";
import { createSarvamSpeechProvider } from "./sarvam-provider.js";
import { createChainedSpeechProvider } from "./provider-chain.js";
import type { SpeechEnv } from "../config/env.js";

/** A provider that refuses every session; used when nothing is configured. */
export function createUnconfiguredProvider(): SpeechProvider {
  return {
    id: "none",
    streaming: false,
    interim: false,
    languages: [],
    open() {
      return {
        push: () => {},
        stop: () => {},
        close: () => {},
      };
    },
  };
}

/** Build the configured provider, its Sarvam→Deepgram fallback included. */
export function createSpeechProvider(speech: SpeechEnv): SpeechProvider {
  if (speech.provider === "mock") return createMockSpeechProvider();
  if (speech.mode === "none" || speech.provider === "none") {
    return createUnconfiguredProvider();
  }
  const deepgram = speech.deepgramApiKey
    ? createDeepgramSpeechProvider({
        apiKey: speech.deepgramApiKey,
        model: speech.deepgramModel,
        url: speech.providerUrl ?? undefined,
      })
    : null;
  const sarvam = speech.sarvamApiKey
    ? createSarvamSpeechProvider({
        apiKey: speech.sarvamApiKey,
        model: speech.sarvamModel,
        fallback: deepgram,
      })
    : null;
  const ordered: readonly (SpeechProvider | null)[] =
    speech.mode === "deepgram"
      ? [deepgram]
      : speech.mode === "sarvam"
        ? [sarvam]
        : [sarvam, deepgram];
  const chain = createChainedSpeechProvider(
    ordered.filter((entry): entry is SpeechProvider => entry !== null),
  );
  return chain ?? createUnconfiguredProvider();
}
