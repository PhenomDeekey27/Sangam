/**
 * Build the configured speech provider. Kept separate from the provider
 * itself so the rest of the server depends on the interface, never on a
 * concrete vendor.
 */
import type { SpeechProvider } from "./provider.js";
import { createMockSpeechProvider } from "./mock-provider.js";
import { createDeepgramSpeechProvider } from "./deepgram-provider.js";
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

export function createSpeechProvider(speech: SpeechEnv): SpeechProvider {
  if (speech.provider === "mock") return createMockSpeechProvider();
  if (speech.provider === "deepgram" && speech.deepgramApiKey) {
    return createDeepgramSpeechProvider({
      apiKey: speech.deepgramApiKey,
      model: speech.deepgramModel,
      url: speech.providerUrl ?? undefined,
    });
  }
  return createUnconfiguredProvider();
}
