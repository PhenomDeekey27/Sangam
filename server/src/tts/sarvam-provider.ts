/**
 * Sarvam Bulbul text-to-speech adapter (preferred provider).
 *
 * One documented REST round trip per text segment; the key travels only in the
 * `api-subscription-key` header. The voice, model and regional code for a
 * language all come from the shared registry
 * (`server/src/sarvam/language-codes.ts`), so nothing here hardcodes a voice
 * or guesses a pair the vendor does not publish — an unknown language raises
 * `unsupported` and the chain falls through to Gemini.
 *
 * Authoritative basis (docs.sarvam.ai, October 2026):
 * - `POST https://api.sarvam.ai/text-to-speech`, header `api-subscription-key`.
 * - body `{ text, language_code, speaker, model, speech_sample_rate,
 *   output_audio_codec }`; response `{ audios: [base64 WAV, …] }`.
 * - `bulbul:v4-flash` persona voices are `<name>_<language>_<style>`; Malayalam
 *   has no published v4-flash voice and uses the documented `bulbul:v3`
 *   `shubh` speaker.
 *
 * A translation longer than the per-request ceiling is split at sentence
 * boundaries, synthesized segment by segment, and merged into one WAV so the
 * socket contract still delivers a single self-describing container.
 */
import { normalizeLanguage } from "../rooms/room-validation.js";
import { sarvamRequest, type SarvamFailure } from "../sarvam/http.js";
import {
  SARVAM_TTS_LANGUAGES,
  sarvamVoiceFor,
  type SarvamVoice,
} from "../sarvam/language-codes.js";
import { mergeWav } from "./wav.js";
import {
  TtsProviderError,
  type TtsProvider,
  type TtsRequest,
  type TtsResult,
} from "./provider.js";

export const SARVAM_TTS_ENDPOINT = "https://api.sarvam.ai/text-to-speech";
/** Documented v4 default; a language's registry entry may override it. */
export const SARVAM_DEFAULT_TTS_MODEL = "bulbul:v4-flash";
/** Bulbul's documented per-request character ceiling. */
export const SARVAM_TTS_MAX_CHARS = 2500;
/** Documented output sample rate for WAV playback. */
const SAMPLE_RATE = 22_050;
/** Per-request deadline (synthesis is a single short round trip). */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface SarvamTtsProviderOptions {
  /** Sarvam API key. Stored server-side; never logged or emitted. */
  readonly apiKey: string;
  /** Optional model override; each language's registry model is the default. */
  readonly model?: string | null;
  /**
   * Optional voice override. Documented as an advanced escape hatch: it
   * replaces the registry voice for every supported language, so a single
   * persona is used across them.
   */
  readonly voice?: string | null;
  /** Override the endpoint (self-hosted proxies, tests). */
  readonly endpoint?: string | null;
  /** Per-request deadline in milliseconds. */
  readonly timeoutMs?: number;
  /** Injectable HTTP layer; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/** Map a normalized Sarvam failure onto the TTS error contract. */
export function toTtsError(failure: SarvamFailure): TtsProviderError {
  switch (failure.kind) {
    case "auth":
      return new TtsProviderError(
        "auth",
        "Sarvam playback rejected its credentials",
        failure.status,
      );
    case "rate_limited":
      return new TtsProviderError(
        "rate_limited",
        "Sarvam playback quota or rate limit reached",
        failure.status,
      );
    case "timeout":
      return new TtsProviderError(
        "timeout",
        "Sarvam playback timed out",
        failure.status,
      );
    case "rejected":
      return new TtsProviderError(
        "unsupported",
        "Sarvam playback rejected the request",
        failure.status,
      );
    case "malformed":
      return new TtsProviderError(
        "unknown",
        "Sarvam playback returned an unusable response",
        failure.status,
      );
    case "server":
    case "network":
      return new TtsProviderError(
        "network",
        "Sarvam playback is unreachable",
        failure.status,
      );
  }
}

export class SarvamTtsProvider implements TtsProvider {
  readonly id = "sarvam" as const;
  readonly languages: readonly string[] = SARVAM_TTS_LANGUAGES;
  readonly cacheTag: string;
  private readonly apiKey: string;
  private readonly modelOverride: string | null;
  private readonly voiceOverride: string | null;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SarvamTtsProviderOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new Error("SarvamTtsProvider requires a non-empty apiKey");
    }
    this.apiKey = apiKey;
    this.modelOverride = options.model?.trim() || null;
    this.voiceOverride = options.voice?.trim() || null;
    this.endpoint = options.endpoint?.trim() || SARVAM_TTS_ENDPOINT;
    this.timeoutMs =
      typeof options.timeoutMs === "number" && options.timeoutMs > 0
        ? Math.floor(options.timeoutMs)
        : DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    // Model plus the fixed/override voice identify this engine in the cache.
    const model = this.modelOverride ?? SARVAM_DEFAULT_TTS_MODEL;
    this.cacheTag = `sarvam:${model}:${this.voiceOverride ?? "registry"}`;
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const voice = sarvamVoiceFor(request.language ?? "");
    if (!voice) {
      throw new TtsProviderError(
        "unsupported",
        `Sarvam has no voice for ${normalizeLanguage(request.language ?? "") || "?"}`,
      );
    }
    const segments = segmentText(request.text ?? "", SARVAM_TTS_MAX_CHARS);
    if (segments.length === 0) {
      throw new TtsProviderError("unsupported", "unspeakable text: empty");
    }
    const audios: Buffer[] = [];
    for (const segment of segments) {
      audios.push(...(await this.synthesizeSegment(segment, voice)));
    }
    const audio = mergeWav(audios);
    if (!audio) {
      throw new TtsProviderError(
        "unknown",
        "Sarvam playback returned no usable audio",
      );
    }
    return { audio, mimeType: "audio/wav" };
  }

  /** One segment: request, status mapping, base64 decode. */
  private async synthesizeSegment(
    text: string,
    voice: SarvamVoice,
  ): Promise<Buffer[]> {
    const result = await sarvamRequest({
      url: this.endpoint,
      apiKey: this.apiKey,
      body: JSON.stringify({
        text,
        language_code: voice.code,
        speaker: this.voiceOverride ?? voice.voice,
        model: this.modelOverride ?? voice.model,
        speech_sample_rate: SAMPLE_RATE,
        output_audio_codec: "wav",
      }),
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
    if (!result.ok) throw toTtsError(result.failure);
    const encoded = readAudioParts(result.body);
    if (!encoded || encoded.length === 0) {
      throw new TtsProviderError(
        "unknown",
        "Sarvam playback returned no audio",
        result.status,
      );
    }
    return encoded.map((part) => Buffer.from(part, "base64"));
  }
}

/** The documented `audios` array of base64 payloads, or `null`. */
export function readAudioParts(body: unknown): string[] | null {
  if (typeof body !== "object" || body === null) return null;
  const audios = (body as { audios?: unknown }).audios;
  if (!Array.isArray(audios)) return null;
  const parts = audios.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return parts;
}

/**
 * Split text into chunks no longer than `maxChars`, preferring sentence
 * boundaries (`.`/`!`/`?`/Devanagari danda). A single over-long sentence is
 * hard-split so no request can exceed the vendor ceiling. Whitespace between
 * sentences is normalized to a single space — the text is spoken, so layout is
 * irrelevant.
 */
export function segmentText(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= maxChars) return [trimmed];
  const sentences =
    trimmed
      .match(/[^.!?।]+[.!?।]*/g)
      ?.map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 0) ?? [trimmed];
  const out: string[] = [];
  const push = (value: string): void => {
    const cleaned = value.trim();
    if (cleaned.length > 0) out.push(cleaned);
  };
  let current = "";
  for (const sentence of sentences) {
    if (current.length > 0) {
      if (current.length + 1 + sentence.length <= maxChars) {
        current = `${current} ${sentence}`;
        continue;
      }
      push(current);
      current = "";
    }
    current = sentence;
    // A single sentence over the ceiling: hard-split it.
    while (current.length > maxChars) {
      push(current.slice(0, maxChars));
      current = current.slice(maxChars);
    }
  }
  push(current);
  return out;
}
