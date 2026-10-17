/**
 * Server-side configuration, validated once at startup.
 *
 * The browser must only ever see `NEXT_PUBLIC_*` values from the frontend
 * `.env.local`; everything validated here stays inside the Node process.
 * See the repository `.env.example` for documented placeholders.
 */
import type { SpeechProviderId } from "../../../src/types/socket.js";
export interface ServerEnv {
  /** TCP port the HTTP + Socket.IO server listens on. */
  readonly port: number;
  /** Exact browser origins allowed by CORS (never `*` in production). */
  readonly clientOrigins: readonly string[];
  readonly isProduction: boolean;
  /** Speech pipeline configuration; defaults to "unconfigured" when absent. */
  readonly speech?: SpeechEnvInput;
  /** Machine-translation configuration; unavailable when unconfigured. */
  readonly translation?: TranslationEnvInput;
  /** Text-to-speech (playback) configuration; unavailable when unconfigured. */
  readonly tts?: TtsEnvInput;
}

/**
 * How the server chooses a speech-to-text engine:
 * - `auto`     — use the real provider when its key is present, else none.
 * - `deepgram` — require the real provider (a missing key is a startup error).
 * - `mock`     — deterministic double for development and tests only.
 * - `none`     — never run server recognition (clients fall back to the
 *                browser or the text composer).
 */
export type SpeechProviderMode = "auto" | "deepgram" | "mock" | "none";

/** Raw (possibly partial) speech configuration as supplied by tests or env. */
export interface SpeechEnvInput {
  readonly provider?: string;
  readonly deepgramApiKey?: string | null;
  readonly deepgramModel?: string;
  readonly maxSessionBytes?: number;
  readonly providerUrl?: string | null;
}

/** Validated speech configuration with a resolved provider. */
export interface SpeechEnv {
  readonly mode: SpeechProviderMode;
  readonly provider: SpeechProviderId;
  readonly deepgramApiKey: string | null;
  readonly deepgramModel: string;
  readonly maxSessionBytes: number;
  readonly providerUrl: string | null;
}

/**
 * How the server chooses a machine-translation vendor:
 * - `auto`   — Google primary, plus Gemini fallback when its key is present.
 * - `google` — Google primary only; Gemini fallback explicitly disabled.
 * - `gemini` — Google primary, Gemini fallback required (a missing key is a
 *                startup error, as before).
 * - `none`   — never translate (utterances stay `unavailable`).
 */
export type TranslationProviderMode = "auto" | "google" | "gemini" | "none";

/** Raw (possibly partial) translation configuration. */
export interface TranslationEnvInput {
  readonly provider?: string | null;
  readonly apiKey?: string | null;
  readonly model?: string | null;
}

/** Validated translation configuration. The key stays server-side. */
export interface TranslationEnv {
  readonly mode: TranslationProviderMode;
  /** Effective primary vendor, or `null` when translation is unavailable. */
  readonly primary: "google" | null;
  /** Effective fallback vendor, or `null` when fallback is disabled. */
  readonly fallback: "gemini" | null;
  readonly apiKey: string | null;
  readonly model: string;
}

/**
 * How the server chooses a text-to-speech vendor (Stage 6 playback):
 * - `auto`  — Gemini TTS when a Gemini key is present, else none.
 * - `gemini` — require Gemini TTS (a missing key is a startup error).
 * - `none`  — never synthesize (listeners only ever read the transcript).
 */
export type TtsProviderMode = "auto" | "gemini" | "none";

/** Raw (possibly partial) text-to-speech configuration. */
export interface TtsEnvInput {
  readonly provider?: string | null;
  readonly apiKey?: string | null;
  readonly model?: string | null;
  readonly voice?: string | null;
}

/** Validated text-to-speech configuration. The key stays server-side. */
export interface TtsEnv {
  readonly mode: TtsProviderMode;
  /** Effective vendor, or `null` when playback is unavailable. */
  readonly provider: "gemini" | null;
  readonly apiKey: string | null;
  readonly model: string;
  readonly voice: string;
}

const TTS_MODES: readonly TtsProviderMode[] = ["auto", "gemini", "none"];

const DEFAULT_TTS_MODEL = "gemini-3.8-flash-lite-tts";
const DEFAULT_TTS_VOICE = "Kore";

/** Resolve partial text-to-speech configuration into an explicit shape. */
export function resolveTtsEnv(input: TtsEnvInput = {}): TtsEnv {
  const requested = (input.provider ?? "auto").trim().toLowerCase();
  const mode: TtsProviderMode = (TTS_MODES as readonly string[]).includes(
    requested,
  )
    ? (requested as TtsProviderMode)
    : "auto";
  const key = input.apiKey?.trim();
  const apiKey = key && key.length > 0 ? key : null;
  if (mode === "gemini" && !apiKey) {
    throw new Error(
      "TTS_PROVIDER=gemini requires GEMINI_API_KEY (or TTS_API_KEY) to be set in server/.env (see .env.example)",
    );
  }
  return {
    mode,
    provider: mode === "none" || !apiKey ? null : "gemini",
    apiKey,
    model: input.model?.trim() || DEFAULT_TTS_MODEL,
    voice: input.voice?.trim() || DEFAULT_TTS_VOICE,
  };
}

const TRANSLATION_MODES: readonly TranslationProviderMode[] = [
  "auto",
  "google",
  "gemini",
  "none",
];

const DEFAULT_TRANSLATION_MODEL = "gemini-3.5-flash-lite";

/** Resolve partial translation configuration into an explicit shape. */
export function resolveTranslationEnv(
  input: TranslationEnvInput = {},
): TranslationEnv {
  const requested = (input.provider ?? "auto").trim().toLowerCase();
  const mode: TranslationProviderMode = (
    TRANSLATION_MODES as readonly string[]
  ).includes(requested)
    ? (requested as TranslationProviderMode)
    : "auto";
  const key = input.apiKey?.trim();
  const apiKey = key && key.length > 0 ? key : null;
  if (mode === "gemini" && !apiKey) {
    throw new Error(
      "TRANSLATION_PROVIDER=gemini requires GEMINI_API_KEY to be set in server/.env (see .env.example)",
    );
  }
  return {
    mode,
    primary: mode === "none" ? null : "google",
    fallback:
      (mode === "gemini" || mode === "auto") && apiKey ? "gemini" : null,
    apiKey,
    model: input.model?.trim() || DEFAULT_TRANSLATION_MODEL,
  };
}

const DEV_DEFAULT_ORIGIN = "http://localhost:3000";
const PORT_FALLBACK = 4000;
const DEFAULT_MAX_SESSION_BYTES = 12_000_000;
const DEFAULT_DEEPGRAM_MODEL = "nova-3";
const PROVIDER_MODES: readonly SpeechProviderMode[] = [
  "auto",
  "deepgram",
  "mock",
  "none",
];

/** Resolve partial speech configuration into a validated, explicit shape. */
export function resolveSpeechEnv(input: SpeechEnvInput = {}): SpeechEnv {
  const requested = (input.provider ?? "auto").trim().toLowerCase();
  const mode: SpeechProviderMode = (
    PROVIDER_MODES as readonly string[]
  ).includes(requested)
    ? (requested as SpeechProviderMode)
    : "auto";
  const key = input.deepgramApiKey?.trim();
  const deepgramApiKey = key && key.length > 0 ? key : null;
  if (mode === "deepgram" && !deepgramApiKey) {
    throw new Error(
      "SPEECH_PROVIDER=deepgram requires DEEPGRAM_API_KEY to be set in server/.env (see .env.example)",
    );
  }
  const provider: SpeechProviderId =
    mode === "mock"
      ? "mock"
      : mode === "none"
        ? "none"
        : mode === "deepgram"
          ? "deepgram"
          : deepgramApiKey
            ? "deepgram"
            : "none";
  const maxBytes = input.maxSessionBytes;
  return {
    mode,
    provider,
    deepgramApiKey,
    deepgramModel: input.deepgramModel?.trim() || DEFAULT_DEEPGRAM_MODEL,
    maxSessionBytes:
      typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0
        ? Math.floor(maxBytes)
        : DEFAULT_MAX_SESSION_BYTES,
    providerUrl: input.providerUrl?.trim() || null,
  };
}

function parsePort(value: string | undefined): number {
  const port =
    value === undefined || value === "" ? PORT_FALLBACK : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(
      `PORT must be an integer between 0 and 65535, got "${value}"`,
    );
  }
  return port;
}

function parseOrigins(
  value: string | undefined,
  isProduction: boolean,
): string[] {
  const raw = value?.trim() ?? DEV_DEFAULT_ORIGIN;
  const origins = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (origins.length === 0) {
    throw new Error("CLIENT_ORIGIN must list at least one origin");
  }
  for (const origin of origins) {
    if (origin === "*") {
      if (isProduction) {
        throw new Error("Wildcard CORS (*) is not allowed in production");
      }
      continue;
    }
    try {
      const url = new URL(origin);
      if (url.pathname !== "/" || url.search || url.hash) {
        throw new Error("origin must be scheme://host[:port] with no path");
      }
    } catch (error) {
      throw new Error(
        `CLIENT_ORIGIN contains an invalid origin "${origin}": ${String(error)}`,
      );
    }
  }
  return origins;
}

/** Read and validate configuration, throwing a descriptive error on misuse. */
export function loadEnv(raw: NodeJS.ProcessEnv = process.env): ServerEnv {
  const isProduction = raw.NODE_ENV === "production";
  return {
    port: parsePort(raw.PORT),
    clientOrigins: parseOrigins(raw.CLIENT_ORIGIN, isProduction),
    isProduction,
    speech: resolveSpeechEnv({
      provider: raw.SPEECH_PROVIDER,
      deepgramApiKey: raw.DEEPGRAM_API_KEY ?? null,
      deepgramModel: raw.DEEPGRAM_MODEL,
      maxSessionBytes: raw.SPEECH_MAX_SESSION_BYTES
        ? Number(raw.SPEECH_MAX_SESSION_BYTES)
        : undefined,
      providerUrl: raw.DEEPGRAM_PROVIDER_URL ?? null,
    }),
    translation: resolveTranslationEnv({
      provider: raw.TRANSLATION_PROVIDER,
      apiKey: raw.GEMINI_API_KEY ?? null,
      model: raw.GEMINI_TRANSLATION_MODEL ?? null,
    }),
    tts: resolveTtsEnv({
      provider: raw.TTS_PROVIDER,
      // Playback shares the Gemini credential by default; TTS_API_KEY may
      // point it at a separate project.
      apiKey: raw.TTS_API_KEY ?? raw.GEMINI_API_KEY ?? null,
      model: raw.TTS_MODEL,
      voice: raw.TTS_VOICE,
    }),
  };
}
