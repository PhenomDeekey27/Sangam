/**
 * Primary translation provider: the unofficial Google Translate endpoints.
 * Keyless and fast, so it fronts every utterance; the Gemini vendor remains
 * as fallback for when this endpoint refuses, throttles, or misbehaves (see
 * `translation-chain.ts`).
 *
 * Primary endpoint (verified live, see `google-translate-response.ts` for the
 * redacted captures): `clients5.google.com/translate_a/t` with
 * `client=dict-chrome-ex`, which currently returns a plain JSON array of
 * translated segment strings. `translate.googleapis.com/translate_a/single`
 * (`client=gtx`, `dt=t`) is selectable as an alternate that returns the
 * nested `sentences`-style rows. Both are supported through one parser so an
 * endpoint stays configurable without a second parser path.
 *
 * This is not an official Google API: it can rate-limit, change shape, or
 * go away without notice. Nothing here depends on that — every failure is a
 * `TranslationProviderError` with a safe code, and no secret is ever sent
 * (the endpoint takes no key, cookie, or credential).
 */
import { isLanguageCode, normalizeLanguage } from "../rooms/room-validation.js";
import {
  parseGoogleTranslationResponse,
  type GoogleResponseFormat,
} from "./google-translate-response.js";
import {
  TranslationProviderError,
  type TranslationResult,
  type TranslationRequest,
  type Translator,
} from "./translator.js";

const ENDPOINT_T = "https://clients5.google.com/translate_a/t";
const ENDPOINT_SINGLE = "https://translate.googleapis.com/translate_a/single";
const MAX_TEXT_LENGTH = 1000;
const MAX_OUTPUT_CHARS = 2000;
/** Short deadline: the fallback owns the rest of the latency budget. */
const DEFAULT_TIMEOUT_MS = 3_000;

/**
 * Endpoint variants served by the same unofficial API. The default stays the
 * keyless dictionary client; `single` is the alternate verified to return
 * per-segment rows with a detected source language.
 */
export type GoogleTranslateEndpointId = "t" | "single";

const ENDPOINT_CONFIG: Readonly<
  Record<GoogleTranslateEndpointId, Readonly<{ url: string; query: Record<string, string> }>>
> = {
  t: { url: ENDPOINT_T, query: { client: "dict-chrome-ex" } },
  single: {
    url: ENDPOINT_SINGLE,
    query: { client: "gtx", dt: "t" },
  },
};

/** Browser-like UA: these endpoints serve Chrome's own translation client. */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Endpoint language code for a validated Sangam code. Chinese is the one
 * alias that needs endpoint form (`zh-CN`); every other supported code is
 * already what the endpoint expects. Returns `null` when unsupported.
 */
export function endpointLanguage(code: string): string | null {
  const normalized = normalizeLanguage(code ?? "");
  if (!isLanguageCode(normalized)) return null;
  if (normalized === "zh") return "zh-CN";
  return normalized;
}

/** Primary-subtag form (`zh-CN` → `zh`) for comparing endpoint `src` codes. */
function primarySubtag(code: string): string {
  return code.trim().toLowerCase().split("-")[0] ?? "";
}

export interface GoogleTranslateUnofficialOptions {
  /** Per-request deadline in milliseconds. */
  readonly timeoutMs?: number;
  /** Injectable HTTP layer; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Which verified endpoint to call; defaults to the plain-array `t`
   * endpoint. Configurable so shape drift on one host can be dodged without
   * a code rewrite.
   */
  readonly endpoint?: GoogleTranslateEndpointId;
  /**
   * Development-only structural diagnostic. Receives a redacted summary
   * (format + rejection reason) — never the transcript, the translation, or
   * any credential.
   */
  readonly onEvent?: (event: GoogleProviderEvent) => void;
}

/** Safe, redacted per-stage diagnostic events (development use). */
export type GoogleProviderEvent =
  | { readonly stage: "request_started"; readonly sl: string; readonly tl: string }
  | { readonly stage: "http_status"; readonly status: number }
  | { readonly stage: "response_format"; readonly format: GoogleResponseFormat }
  | { readonly stage: "translation_extracted"; readonly charCount: number }
  | {
      readonly stage: "response_rejected";
      readonly reason: "echo" | "empty" | "malformed" | "unexpected";
    };

export class GoogleTranslateUnofficialProvider implements Translator {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly endpointId: GoogleTranslateEndpointId;
  private readonly onEvent?: (event: GoogleProviderEvent) => void;

  constructor(options: GoogleTranslateUnofficialOptions = {}) {
    this.timeoutMs =
      typeof options.timeoutMs === "number" && options.timeoutMs > 0
        ? Math.floor(options.timeoutMs)
        : DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpointId = options.endpoint ?? "t";
    this.onEvent = options.onEvent;
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    const source = normalizeLanguage(request.sourceLanguage ?? "");
    const target = normalizeLanguage(request.targetLanguage ?? "");
    const sl = endpointLanguage(source);
    const tl = endpointLanguage(target);
    if (!sl || !tl) {
      // No retryable fallback: Gemini shares this mapping and would refuse
      // the same pair, so surface `unsupported` directly (existing behavior).
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

    const config = ENDPOINT_CONFIG[this.endpointId];
    // URLSearchParams handles all escaping — user text is never spliced
    // into a URL by hand.
    const url = new URL(config.url);
    for (const [key, value] of Object.entries(config.query)) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set("sl", sl);
    url.searchParams.set("tl", tl);
    url.searchParams.set("q", text);
    this.emit({ stage: "request_started", sl, tl });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // Never hold the process open for a hung provider call.
    (timer as unknown as { unref?: () => void }).unref?.();
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: "GET",
        headers: { "User-Agent": USER_AGENT },
        signal: controller.signal,
      });
    } catch (error) {
      throw new TranslationProviderError(
        isAbortError(error) ? "timeout" : "network",
        `google translate request failed: ${errorName(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    this.emit({ stage: "http_status", status: response.status });

    if (response.status === 429) {
      throw new TranslationProviderError(
        "rate_limited",
        "google translate rate limit exceeded (429)",
        response.status,
      );
    }
    if (response.status === 403 || response.status === 401) {
      throw new TranslationProviderError(
        "auth",
        `google translate refused the request (${response.status})`,
        response.status,
      );
    }
    if (!response.ok) {
      throw new TranslationProviderError(
        response.status >= 500 ? "network" : "unknown",
        `google translate unavailable (${response.status})`,
        response.status,
      );
    }

    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch {
      this.emit({ stage: "response_rejected", reason: "malformed" });
      throw new TranslationProviderError(
        "unknown",
        "google translate response was not JSON",
        response.status,
      );
    }

    const parse = parseGoogleTranslationResponse(body);
    this.emit({ stage: "response_format", format: parse.ok ? parse.segments.format : parse.format });
    if (!parse.ok) {
      this.emit({ stage: "response_rejected", reason: parse.rejection });
      throw new TranslationProviderError(
        "unknown",
        `google translate response rejected: ${parse.rejection} (${parse.format})`,
        response.status,
      );
    }

    /*
     * Join segments preserving their own internal spacing, then collapse:
     * endpoint B segments carry trailing spaces that must not duplicate.
     */
    const translated = parse.segments.parts
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!translated || translated.length > MAX_OUTPUT_CHARS) {
      this.emit({ stage: "response_rejected", reason: "empty" });
      throw new TranslationProviderError(
        "unknown",
        "google translate response carried no usable text",
        response.status,
      );
    }

    /*
     * An echo of the input normally means the endpoint ignored the request
     * (e.g. a block page shaped like success). The endpoint reports the
     * source it actually used when it can (`src` / detected language):
     * only reject the echo when that report disagrees with the requested
     * source, since identical text is legitimately valid for names and
     * words that need no translation (verified: "Stalin" → "ஸ்டாலின்"
     * transliterates, but names can pass through unchanged).
     */
    const reported =
      parse.segments.detectedSource !== null
        ? primarySubtag(parse.segments.detectedSource)
        : "";
    if (translated === text && reported && reported !== source) {
      this.emit({ stage: "response_rejected", reason: "echo" });
      throw new TranslationProviderError(
        "unknown",
        "google translate echoed the source text",
        response.status,
      );
    }

    this.emit({ stage: "translation_extracted", charCount: translated.length });
    return { text: translated, targetLanguage: target };
  }

  private emit(event: GoogleProviderEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // Diagnostics must never break translation.
    }
  }
}

function isAbortError(error: unknown): boolean {
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
