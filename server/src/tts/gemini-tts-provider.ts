/**
 * Gemini text-to-speech provider (`gemini-3.8-flash-lite-tts` by default).
 *
 * Uses the documented Gemini REST API (no extra dependency), following the
 * same conventions as the translation provider in
 * `../translation/gemini-provider.ts`: the key travels only in the
 * `x-goog-api-key` header, never in URLs, errors, or logs, and every failure
 * surfaces as `TtsProviderError` with a safe code.
 *
 * Authoritative basis (ai.google.dev/gemini-api/docs/speech-generation):
 * - REST `POST {endpoint}/v1beta/interactions` with body
 *   `{model, input, response_format: {type: "audio"}, generation_config}`.
 * - Unary requests return a complete WAV (`audio/wav`, 24 kHz mono 16-bit)
 *   whose base64 bytes sit in `steps[]` → model_output → audio content
 *   `.data`; the raw PCM payload is wrapped by the provider, so no manual
 *   WAV header is needed here.
 * - Language: TTS models detect the input language automatically, so the
 *   request needs no language field; the caller validates the code against
 *   Sangam's supported list before invoking.
 */
import {
  TtsProviderError,
  type TtsProvider,
  type TtsRequest,
  type TtsResult,
} from "./provider.js";

const DEFAULT_ENDPOINT = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-3.8-flash-lite-tts";
const DEFAULT_VOICE = "Kore";
const DEFAULT_MIME_TYPE = "audio/wav";
/** Matches the room's relayed-text ceiling (composer caps at 280 anyway). */
const MAX_TEXT_LENGTH = 1000;
/** ~80 s of 24 kHz mono 16-bit PCM — a hard sanity ceiling on returned audio. */
const MAX_AUDIO_BYTES = 4_000_000;
const MAX_ERROR_BODY_CHARS = 200;
/** Per-request deadline: synthesis must not outwait a conversation turn. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** One automatic retry, only for timeout/network failures. */
const MAX_ATTEMPTS = 2;
/** Breathing room before the single retry. */
const RETRY_DELAY_MS = 500;

export interface GeminiTtsProviderOptions {
  /** Gemini API key. Stored server-side; never logged or emitted. */
  readonly apiKey: string;
  /** Model code; defaults to `gemini-3.8-flash-lite-tts`. */
  readonly model?: string | null;
  /** Prebuilt studio voice name; defaults to `Kore`. */
  readonly voice?: string | null;
  /** Per-request deadline in milliseconds. */
  readonly timeoutMs?: number;
  /** Injectable HTTP layer; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export class GeminiTtsProvider implements TtsProvider {
  readonly id = "gemini" as const;
  /** Empty: the model auto-detects every language Sangam supports. */
  readonly languages: readonly string[] = [];
  private readonly apiKey: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiTtsProviderOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new Error("GeminiTtsProvider requires a non-empty apiKey");
    }
    this.apiKey = apiKey;
    this.model = options.model?.trim() || DEFAULT_MODEL;
    this.voice = options.voice?.trim() || DEFAULT_VOICE;
    this.timeoutMs =
      typeof options.timeoutMs === "number" && options.timeoutMs > 0
        ? Math.floor(options.timeoutMs)
        : DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const text = request.text?.trim() ?? "";
    if (!text || text.length > MAX_TEXT_LENGTH) {
      throw new TtsProviderError(
        "unsupported",
        "unspeakable text: empty or over the length limit",
      );
    }

    const url = `${DEFAULT_ENDPOINT}/v1beta/interactions`;
    const body = JSON.stringify({
      model: this.model,
      input: [
        {
          type: "user_input",
          content: [{ type: "text", text }],
        },
      ],
      response_format: { type: "audio" },
      generation_config: {
        speech_config: [{ voice: this.voice }],
      },
    });
    let lastError: TtsProviderError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.attempt(url, body);
      } catch (error) {
        // Retry once on timeout/network blips; every other failure (auth,
        // rate limit, rejection, malformed response) is final right away.
        if (
          !(error instanceof TtsProviderError) ||
          (error.code !== "timeout" && error.code !== "network") ||
          attempt >= MAX_ATTEMPTS
        ) {
          throw error;
        }
        lastError = error;
        await retryDelay();
      }
    }
    // Unreachable: the loop above always returns or throws. Kept for safety.
    throw (
      lastError ??
      new TtsProviderError("unknown", "synthesis did not complete")
    );
  }

  /** One interactions round trip: fetch, status mapping, and parsing. */
  private async attempt(url: string, body: string): Promise<TtsResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // Never hold the process open for a hung provider call.
    (timer as unknown as { unref?: () => void }).unref?.();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "x-goog-api-key": this.apiKey,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      throw new TtsProviderError(
        isAbortError(error) ? "timeout" : "network",
        `synthesis request failed: ${errorName(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      throw new TtsProviderError(
        "rate_limited",
        "synthesis rate limit exceeded (429)",
        response.status,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new TtsProviderError(
        "auth",
        `synthesis not authorized (${response.status})`,
        response.status,
      );
    }
    if (response.status === 400) {
      const detail = await safeErrorBody(response);
      throw new TtsProviderError(
        "unsupported",
        `synthesis rejected (400): ${detail}`,
        response.status,
      );
    }
    if (response.status === 404) {
      throw new TtsProviderError(
        "unknown",
        `synthesis model unavailable (${response.status})`,
        response.status,
      );
    }
    if (response.status >= 500 || !response.ok) {
      throw new TtsProviderError(
        "network",
        `synthesis unavailable (${response.status})`,
        response.status,
      );
    }
    return parseSuccess(response);
  }
}

async function parseSuccess(response: Response): Promise<TtsResult> {
  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch {
    throw new TtsProviderError(
      "unknown",
      "synthesis response was not JSON",
      response.status,
    );
  }
  if (!isRecord(body)) {
    throw new TtsProviderError(
      "unknown",
      "synthesis response had an unexpected shape",
      response.status,
    );
  }
  const audioData = lastAudioData(body);
  if (!audioData) {
    throw new TtsProviderError(
      "unknown",
      "synthesis response carried no audio",
      response.status,
    );
  }
  const audio = Buffer.from(audioData, "base64");
  if (audio.length === 0 || audio.length > MAX_AUDIO_BYTES) {
    throw new TtsProviderError(
      "unknown",
      "synthesis response audio was empty or oversized",
      response.status,
    );
  }
  return { audio, mimeType: DEFAULT_MIME_TYPE };
}

/**
 * Extract the base64 payload of the last audio content item across the
 * interaction's model-output steps (the documented storage location).
 */
function lastAudioData(body: Record<string, unknown>): string | null {
  const steps = Array.isArray(body.steps) ? body.steps : [];
  let data: string | null = null;
  for (const step of steps) {
    if (!isRecord(step)) continue;
    const stepType = typeof step.type === "string" ? step.type : "";
    if (stepType && stepType !== "model_output") continue;
    const content = Array.isArray(step.content) ? step.content : [];
    for (const item of content) {
      if (isRecord(item) && item.type === "audio" && typeof item.data === "string") {
        data = item.data;
      }
    }
  }
  return data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function safeErrorBody(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return body.trim().slice(0, MAX_ERROR_BODY_CHARS) || "empty body";
  } catch {
    return "unreadable body";
  }
}

function isAbortError(error: unknown): boolean {
  // Node's fetch rejects with a DOMException named AbortError, but runtimes
  // and test doubles may surface a plain Error with the same name. Match by
  // name so timeouts are never misclassified as generic network failures.
  return (
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError")
  );
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  return typeof error;
}

/** Short pause before the single retry; never holds the process open. */
function retryDelay(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, RETRY_DELAY_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}
