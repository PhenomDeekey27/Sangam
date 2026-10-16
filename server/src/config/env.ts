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
      "SPEECH_PROVIDER=deepgram requires DEEPGRAM_API_KEY to be set",
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
  };
}
