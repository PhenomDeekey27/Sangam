/**
 * Sarvam Saaras speech-to-text adapter (preferred provider).
 *
 * Integration choice, stated plainly: Sarvam's *realtime* WebSocket endpoint
 * (`GET /speech-to-text-realtime/ws`) only accepts raw mono PCM
 * (`linear16`/`linear32`/`mulaw`/`alaw` at 8 or 16 kHz). Sangam captures with
 * `MediaRecorder`, which produces a containerized codec (WebM/Opus, Ogg/Opus,
 * MP4/AAC). Feeding those bytes to the realtime socket would need a browser
 * AudioWorklet resampler plus a server-side container transcode, both of which
 * would change the existing capture pipeline and its latency budget. This
 * adapter therefore uses the documented **REST** endpoint
 * (`POST /speech-to-text`), which explicitly supports WebM/Opus, Ogg, MP4/M4A,
 * WAV and PCM, and which Sangam's existing session model can drive by
 * buffering one speaking turn and posting it on `stop()`.
 *
 * Consequences, documented rather than hidden:
 * - The session accepts the live chunk stream (so the server pipeline still
 *   reports `streaming: true`) but the vendor call is batched, hence
 *   `interim: false`: interim lines come from the browser pipeline, not here.
 * - `mode` stays at the model default (`transcribe`). Sangam owns translation
 *   in its own stage, so Saaras `translate` mode would bypass the listener's
 *   configured language.
 *
 * Authoritative basis (docs.sarvam.ai, October 2026):
 * - `POST https://api.sarvam.ai/speech-to-text`, header `api-subscription-key`.
 * - multipart fields `file`, `model` (`saaras:v4`), `language_code` (BCP-47).
 * - response `{ request_id, transcript, language_code }`.
 *
 * When the REST call fails, the adapter replays the buffered turn into an
 * optional fallback provider (Deepgram) exactly once, so a Sarvam outage never
 * costs an utterance and no duplicate transcript is emitted.
 */
import type { SpeechProviderId } from "../../../src/types/socket.js";
import {
  SARVAM_STT_LANGUAGES,
  fromSarvamLanguage,
  toSarvamLanguage,
} from "../sarvam/language-codes.js";
import { sarvamRequest, type SarvamFailure } from "../sarvam/http.js";
import type {
  SpeechProvider,
  SpeechProviderError,
  SpeechProviderListeners,
  SpeechProviderSession,
} from "./provider.js";

export const SARVAM_STT_ENDPOINT = "https://api.sarvam.ai/speech-to-text";
export const SARVAM_DEFAULT_STT_MODEL = "saaras:v4";
/** Hard ceiling on buffered audio for one turn (mirrors the session limit). */
const DEFAULT_MAX_TURN_BYTES = 12_000_000;

export interface SarvamSttProviderOptions {
  /** Sarvam API key. Stored server-side; never logged or emitted. */
  readonly apiKey: string;
  /** Model code; defaults to `saaras:v4`. */
  readonly model?: string | null;
  /** Override the endpoint (self-hosted proxies, tests). */
  readonly endpoint?: string | null;
  /** Per-request deadline in milliseconds. */
  readonly timeoutMs?: number;
  /** Buffered-turn ceiling for one session. */
  readonly maxTurnBytes?: number;
  /** Injectable HTTP layer; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Attempted once, with the same buffered audio, when the Sarvam call fails
   * and that provider accepts the session language. Normally Deepgram.
   */
  readonly fallback?: SpeechProvider | null;
}

/** File name (and therefore extension) sent in the multipart upload. */
export function sarvamSttFilename(mimeType: string | undefined): string {
  const base = (mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  switch (base) {
    case "audio/ogg":
      return "turn.ogg";
    case "audio/mp4":
      return "turn.mp4";
    case "audio/mpeg":
      return "turn.mp3";
    case "audio/wav":
      return "turn.wav";
    default:
      return "turn.webm";
  }
}

/** Map a normalized Sarvam failure onto the app's speech error contract. */
export function toSpeechProviderError(
  failure: SarvamFailure,
): SpeechProviderError {
  switch (failure.kind) {
    case "auth":
      return {
        code: "provider_auth",
        message:
          "The speech provider rejected its credentials — check the server's Sarvam key.",
        retryable: false,
      };
    case "rate_limited":
      return {
        code: "provider_quota",
        message:
          "Speech recognition quota is exhausted — type your message, or try again later.",
        retryable: false,
      };
    case "rejected":
    case "malformed":
      return {
        code: "provider_response",
        message:
          "The speech provider could not transcribe this recording — try again or type your message.",
        retryable: false,
      };
    case "timeout":
    case "server":
    case "network":
      return {
        code: "provider_network",
        message:
          "The speech provider is unreachable — turn the microphone off and on to retry.",
        retryable: true,
      };
  }
}

export function createSarvamSpeechProvider(
  options: SarvamSttProviderOptions,
): SpeechProvider {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new Error("createSarvamSpeechProvider requires a non-empty apiKey");
  }
  const resolved = { ...options, apiKey };
  return {
    id: "sarvam" as SpeechProviderId,
    // The session accepts the live chunk stream; the vendor call is batched.
    streaming: true,
    interim: false,
    languages: SARVAM_STT_LANGUAGES,
    open(openOptions) {
      return createSarvamSession(resolved, openOptions);
    },
  };
}

type SessionListeners = Pick<
  SpeechProviderListeners,
  "onFinal" | "onError"
> & {
  readonly language: string;
  readonly mimeType?: string;
};

function createSarvamSession(
  options: SarvamSttProviderOptions & { readonly apiKey: string },
  listeners: SessionListeners,
): SpeechProviderSession {
  const language = listeners.language ?? "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let closed = false;
  let stopped = false;
  let reported = false;
  let delegated: SpeechProviderSession | null = null;
  const controller = new AbortController();
  const maxBytes = options.maxTurnBytes ?? DEFAULT_MAX_TURN_BYTES;

  const report = (error: SpeechProviderError): void => {
    if (closed || reported) return;
    reported = true;
    listeners.onError(error);
  };

  const delegateTo = (fallback: SpeechProvider): void => {
    if (closed) return;
    delegated = fallback.open({
      language,
      mimeType: listeners.mimeType,
      // Interims are suppressed: this replays a finished turn, so a late
      // partial would surface long after the speaker stopped talking.
      onInterim: () => {},
      onFinal: (text, metadata) => {
        if (closed) return;
        listeners.onFinal(text, metadata);
      },
      onError: (error) => report(error),
      onClose: () => {},
    });
    for (const chunk of chunks) {
      if (closed) break;
      delegated.push(chunk);
    }
    delegated.stop();
  };

  const fail = (failure: SarvamFailure): void => {
    // One fallback attempt, with the identical buffered turn, when the
    // fallback both exists and accepts this session language.
    const fallback = options.fallback;
    if (
      fallback &&
      fallback.id !== "none" &&
      (fallback.languages.length === 0 ||
        fallback.languages.includes(language))
    ) {
      delegateTo(fallback);
      return;
    }
    report(toSpeechProviderError(failure));
  };

  const transcribe = async (): Promise<void> => {
    const form = new FormData();
    const mimeType = listeners.mimeType;
    form.append(
      "file",
      new Blob(chunks, { type: mimeType ?? "audio/webm" }),
      sarvamSttFilename(mimeType),
    );
    form.append("model", options.model?.trim() || SARVAM_DEFAULT_STT_MODEL);
    const code = toSarvamLanguage(language);
    if (code) form.append("language_code", code);

    const result = await sarvamRequest({
      url: options.endpoint?.trim() || SARVAM_STT_ENDPOINT,
      apiKey: options.apiKey,
      body: form,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
      signal: controller.signal,
    });
    if (closed) return;
    if (!result.ok) {
      fail(result.failure);
      return;
    }
    const parsed = readTranscript(result.body);
    if (!parsed) {
      report({
        code: "provider_response",
        message:
          "The speech provider returned an unusable response — type your message instead.",
        retryable: false,
      });
      return;
    }
    if (parsed.transcript.length === 0) return; // silence: nothing to relay
    listeners.onFinal(parsed.transcript, {
      detectedLanguage: fromSarvamLanguage(parsed.languageCode),
      confidence: parsed.languageProbability,
    });
  };

  return {
    push(chunk) {
      if (closed || stopped) return;
      if (bytes + chunk.byteLength > maxBytes) {
        report({
          code: "audio_too_large",
          message:
            "The recording limit for one turn was reached — it has been stopped.",
          retryable: true,
        });
        return;
      }
      // Copy: the caller may reuse the transport buffer after `push` returns.
      chunks.push(Uint8Array.from(chunk));
      bytes += chunk.byteLength;
    },
    stop() {
      if (closed || stopped) return;
      stopped = true;
      if (bytes === 0) return; // nothing captured: no upload, no utterance
      void transcribe().catch(() => {
        // `transcribe` records every failure; unreachable backup.
      });
    },
    close() {
      closed = true;
      controller.abort();
      delegated?.close();
      delegated = null;
      chunks.length = 0;
      bytes = 0;
    },
  };
}

interface ParsedTranscript {
  readonly transcript: string;
  readonly languageCode: string | null;
  readonly languageProbability: number | null;
}

/** Validate the documented response shape; `null` for anything unusable. */
export function readTranscript(body: unknown): ParsedTranscript | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as {
    transcript?: unknown;
    language_code?: unknown;
    language_probability?: unknown;
  };
  if (typeof record.transcript !== "string") return null;
  const probability = record.language_probability;
  return {
    transcript: record.transcript.trim(),
    languageCode:
      typeof record.language_code === "string" ? record.language_code : null,
    languageProbability:
      typeof probability === "number" && Number.isFinite(probability)
        ? probability
        : null,
  };
}
