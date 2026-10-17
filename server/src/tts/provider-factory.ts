/**
 * Build the configured text-to-speech chain. Kept separate from the vendors
 * themselves so the rest of the server depends on the `TtsProvider` interface,
 * never on a concrete API.
 *
 * Order is fixed: Sarvam Bulbul (when configured) fronts every language it
 * publishes a voice for, and Gemini TTS (when configured) covers both the
 * languages Sarvam does not speak and Sarvam's failures. Keys are validated by
 * `resolveTtsEnv`, so a configured provider always carries credentials here.
 * A `null` result means server playback is unavailable — clients fall back to
 * the browser's own `speechSynthesis`.
 */
import { GeminiTtsProvider } from "./gemini-tts-provider.js";
import { SarvamTtsProvider } from "./sarvam-provider.js";
import { createChainedTtsProvider } from "./provider-chain.js";
import type { TtsEnv } from "../config/env.js";
import type { TtsProvider } from "./provider.js";

export function createTtsProvider(tts: TtsEnv): TtsProvider | null {
  const sarvam =
    tts.sarvamApiKey && tts.provider === "sarvam"
      ? new SarvamTtsProvider({
          apiKey: tts.sarvamApiKey,
          model: tts.sarvamModel,
          voice: tts.sarvamVoice,
        })
      : null;
  const gemini =
    tts.geminiEnabled && tts.apiKey
      ? new GeminiTtsProvider({
          apiKey: tts.apiKey,
          model: tts.model,
          voice: tts.voice,
        })
      : null;
  return createChainedTtsProvider([sarvam, gemini]);
}
