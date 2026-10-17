/**
 * Gemini translation provider (`gemini-3.5-flash-lite`).
 *
 * Uses the documented Gemini REST API (no extra dependency): the model is a
 * general text model, so translation is a prompted `generateContent` call
 * that must return only the translated text.
 *
 * Authoritative basis (Google AI docs):
 * - Model code `gemini-3.5-flash-lite`, text input/output
 *   (ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite).
 * - REST: `POST {endpoint}/v1beta/models/{model}:generateContent` with the
 *   `x-goog-api-key` header; body `{system_instruction, contents}`; success
 *   carries `candidates[0].content.parts[]` text
 *   (ai.google.dev/gemini-api/docs/text-generation).
 *
 * The API key travels only in the request header, never in URLs, errors, or
 * logs. All failures surface as `TranslationProviderError` with a safe code.
 */
import { isLanguageCode, normalizeLanguage } from "../rooms/room-validation.js";
import {
  TranslationProviderError,
  type TranslationResult,
  type TranslationRequest,
  type Translator,
} from "./translator.js";

const DEFAULT_ENDPOINT = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_TEXT_LENGTH = 1000;
const MAX_OUTPUT_CHARS = 2000;
const MAX_OUTPUT_TOKENS = 512;
const MAX_ERROR_BODY_CHARS = 200;
/** Per-request deadline: translation must never outwait a conversation turn. */
const DEFAULT_TIMEOUT_MS = 25_000;
/** One automatic retry, only for timeout/network failures. */
const MAX_ATTEMPTS = 2;
/** Breathing room before the single retry. */
const RETRY_DELAY_MS = 500;

/** English names used in translation prompts, keyed by Sangam language code. */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: "English",
  hi: "Hindi",
  ta: "Tamil",
  te: "Telugu",
  bn: "Bengali",
  mr: "Marathi",
  kn: "Kannada",
  ml: "Malayalam",
  gu: "Gujarati",
  pa: "Punjabi",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  ar: "Arabic",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
};

/** English prompt name for a supported code, or `null` when unsupported. */
export function languageName(code: string): string | null {
  const normalized = normalizeLanguage(code ?? "");
  if (!isLanguageCode(normalized)) return null;
  return LANGUAGE_NAMES[normalized] ?? null;
}

export interface GeminiTranslatorOptions {
  /** Gemini API key. Stored server-side; never logged or emitted. */
  readonly apiKey: string;
  /** Model code; defaults to `gemini-3.5-flash-lite`. */
  readonly model?: string | null;
  /** Per-request deadline in milliseconds. */
  readonly timeoutMs?: number;
  /** Injectable HTTP layer; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export class GeminiTranslator implements Translator {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiTranslatorOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new Error("GeminiTranslator requires a non-empty apiKey");
    }
    this.apiKey = apiKey;
    this.model = options.model?.trim() || DEFAULT_MODEL;
    this.timeoutMs =
      typeof options.timeoutMs === "number" && options.timeoutMs > 0
        ? Math.floor(options.timeoutMs)
        : DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    const source = normalizeLanguage(request.sourceLanguage ?? "");
    const target = normalizeLanguage(request.targetLanguage ?? "");
    const sourceName = languageName(source);
    const targetName = languageName(target);
    if (!sourceName || !targetName) {
      throw new TranslationProviderError(
        "unsupported",
        `unsupported language pair: ${source || "?"} -> ${target || "?"}`,
      );
    }
    const text = request.text?.trim() ?? "";
    if (!text || text.length > MAX_TEXT_LENGTH) {
      throw new TranslationProviderError(
        "unsupported",
        "untranslatable text: empty or over the length limit",
      );
    }

    const url =
      `${DEFAULT_ENDPOINT}/v1beta/models/${encodeURIComponent(this.model)}` +
      `:generateContent`;
    const body = JSON.stringify({
      system_instruction: {
        parts: [
          {
            text:
              `You are a machine translation engine. Translate the following ` +
              `${sourceName} text into ${targetName}. Respond with only the ` +
              `translated text — no explanations, no quotation marks, no commentary.`,
          },
        ],
      },
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    });
    let lastError: TranslationProviderError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.attempt(url, body, target);
      } catch (error) {
        // Retry once on timeout/network blips; every other failure (auth,
        // rate limit, rejection, malformed response) is final right away.
        if (
          !(error instanceof TranslationProviderError) ||
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
      new TranslationProviderError("unknown", "translation did not complete")
    );
  }

  /** One generateContent round trip: fetch, status mapping, and parsing. */
  private async attempt(
    url: string,
    body: string,
    target: string,
  ): Promise<TranslationResult> {
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
      throw new TranslationProviderError(
        isAbortError(error) ? "timeout" : "network",
        `translation request failed: ${errorName(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      throw new TranslationProviderError(
        "rate_limited",
        "translation rate limit exceeded (429)",
        response.status,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new TranslationProviderError(
        "auth",
        `translation not authorized (${response.status})`,
        response.status,
      );
    }
    if (response.status === 400) {
      const detail = await safeErrorBody(response);
      throw new TranslationProviderError(
        "unsupported",
        `translation rejected (400): ${detail}`,
        response.status,
      );
    }
    if (response.status === 404) {
      throw new TranslationProviderError(
        "unknown",
        `translation model unavailable (${response.status})`,
        response.status,
      );
    }
    if (response.status >= 500 || !response.ok) {
      throw new TranslationProviderError(
        "network",
        `translation unavailable (${response.status})`,
        response.status,
      );
    }
    return parseSuccess(response, target);
  }
}

async function parseSuccess(
  response: Response,
  target: string,
): Promise<TranslationResult> {
  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch {
    throw new TranslationProviderError(
      "unknown",
      "translation response was not JSON",
      response.status,
    );
  }
  if (!isRecord(body)) {
    throw new TranslationProviderError(
      "unknown",
      "translation response had an unexpected shape",
      response.status,
    );
  }
  const feedback = body.promptFeedback;
  if (isRecord(feedback) && typeof feedback.blockReason === "string") {
    throw new TranslationProviderError(
      "unknown",
      "translation refused by the provider",
      response.status,
    );
  }
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const first = candidates[0];
  if (!isRecord(first)) {
    throw new TranslationProviderError(
      "unknown",
      "translation response carried no candidates",
      response.status,
    );
  }
  if (
    typeof first.finishReason === "string" &&
    first.finishReason !== "STOP" &&
    first.finishReason !== "MAX_TOKENS"
  ) {
    throw new TranslationProviderError(
      "unknown",
      "translation did not complete",
      response.status,
    );
  }
  const content = first.content;
  const parts =
    isRecord(content) && Array.isArray(content.parts) ? content.parts : [];
  const text = parts
    .filter(
      (part): part is { text: string } =>
        isRecord(part) && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("")
    .trim();
  if (!text || text.length > MAX_OUTPUT_CHARS) {
    throw new TranslationProviderError(
      "unknown",
      "translation response carried no usable text",
      response.status,
    );
  }
  return { text, targetLanguage: target };
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
