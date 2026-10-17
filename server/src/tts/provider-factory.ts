/**
 * Build the configured text-to-speech vendor. Kept separate from the vendors
 * themselves so the rest of the server depends on the `TtsProvider`
 * interface, never on a concrete API.
 *
 * Gemini TTS reuses the server-side `GEMINI_API_KEY` (validated by
 * `resolveTtsEnv`, so a configured provider always carries credentials here).
 * A `null` result means playback is unavailable — utterances keep their
 * translated text and simply never receive audio.
 */
import { GeminiTtsProvider } from "./gemini-tts-provider.js";
import type { TtsEnv } from "../config/env.js";
import type { TtsProvider } from "./provider.js";

export function createTtsProvider(tts: TtsEnv): TtsProvider | null {
  if (tts.provider !== "gemini" || !tts.apiKey) return null;
  return new GeminiTtsProvider({
    apiKey: tts.apiKey,
    model: tts.model,
    voice: tts.voice,
  });
}
