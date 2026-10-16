/**
 * Deepgram streaming adapter (recommended provider).
 *
 * The API key stays on the server. The browser is never given a token; it
 * streams captured audio to our own Socket.IO server, which forwards it here.
 *
 * Protocol notes (verified against Deepgram's published docs and a live
 * handshake; see docs/speech-provider-evaluation.md for what was exercised):
 * - endpoint `wss://api.deepgram.com/v1/listen`, auth as the `token` WebSocket
 *   subprotocol (browsers cannot set the `Authorization` header, and the same
 *   subprotocol works from Node).
 * - `model` (default `nova-3`), per-session `language`, `interim_results`,
 *   `smart_format`; containerized browser audio (webm/opus, mp4) needs no
 *   `encoding`/`sample_rate` because Deepgram reads the container header.
 * - responses shaped `{ type: "Results", is_final, channel: { alternatives:
 *   [{ transcript }] } }`; a session flushes with `{"type":"CloseStream"}`.
 */
import type {
  SpeechProvider,
  SpeechProviderError,
  SpeechProviderListeners,
  SpeechProviderSession,
} from "./provider.js";

/**
 * Languages this adapter accepts, per Deepgram's nova-3 streaming list
 * intersected with Sangam's own supported codes. Seats speaking anything else
 * (currently Marathi, Kannada, Malayalam) are refused up front with a clear
 * error instead of opening a doomed upstream socket.
 */
export const DEEPGRAM_LANGUAGES = [
  "en",
  "hi",
  "ta",
  "te",
  "bn",
  "gu",
  "pa",
  "es",
  "fr",
  "de",
  "pt",
  "ar",
  "ja",
  "ko",
  "zh",
] as const;

export const DEEPGRAM_DEFAULT_MODEL = "nova-3";
const DEEPGRAM_WS_HOST = "wss://api.deepgram.com/v1/listen";

/** Minimal structural WebSocket, matching what the adapter actually uses. */
export interface DeepgramSocket {
  readonly send: (data: string | ArrayBufferLike | ArrayBufferView) => void;
  readonly close: () => void;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
}

/** Opens the upstream socket; injectable so tests never touch the network. */
export type DeepgramSocketFactory = (
  url: string,
  protocols: readonly string[],
) => DeepgramSocket;

export interface DeepgramProviderOptions {
  readonly apiKey: string;
  readonly model?: string;
  /** Override the upstream host (self-hosted proxies, tests). */
  readonly url?: string;
  readonly createSocket?: DeepgramSocketFactory;
}

const authFailure: SpeechProviderError = {
  code: "provider_auth",
  message:
    "The speech provider rejected its credentials — check the server's Deepgram key.",
  retryable: false,
};

const networkFailure: SpeechProviderError = {
  code: "provider_network",
  message:
    "The speech provider connection dropped — turn the microphone off and on to retry.",
  retryable: true,
};

/** Default factory: auth travels as the documented subprotocol token. */
function defaultSocketFactory(url: string, protocols: readonly string[]) {
  const impl = (
    globalThis as unknown as {
      WebSocket?: new (url: string, protocols?: string[]) => DeepgramSocket;
    }
  ).WebSocket;
  if (!impl) {
    throw new Error(
      "No WebSocket implementation is available on this runtime.",
    );
  }
  return new impl(url, [...protocols]);
}

export function createDeepgramSpeechProvider(
  options: DeepgramProviderOptions,
): SpeechProvider {
  const factory = options.createSocket ?? defaultSocketFactory;
  return {
    id: "deepgram",
    streaming: true,
    interim: true,
    languages: DEEPGRAM_LANGUAGES,
    open(openOptions) {
      return createDeepgramSession(
        options,
        openOptions.language,
        factory,
        openOptions,
      );
    },
  };
}

function buildUrl(options: DeepgramProviderOptions, language: string): string {
  const url = new URL(options.url ?? DEEPGRAM_WS_HOST);
  url.searchParams.set("model", options.model ?? DEEPGRAM_DEFAULT_MODEL);
  url.searchParams.set("language", language);
  url.searchParams.set("interim_results", "true");
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("punctuate", "true");
  return url.toString();
}

/** Pull the transcript out of one Deepgram streaming message, if any. */
export function readTranscript(
  raw: unknown,
): { readonly text: string; readonly isFinal: boolean } | null {
  if (typeof raw !== "string") return null;
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof message !== "object" || message === null) return null;
  const record = message as {
    type?: unknown;
    is_final?: unknown;
    channel?: { alternatives?: { transcript?: unknown }[] };
  };
  if (record.type !== "Results") return null;
  const text = record.channel?.alternatives?.[0]?.transcript;
  if (typeof text !== "string" || text.trim().length === 0) return null;
  return { text, isFinal: record.is_final === true };
}

function createDeepgramSession(
  options: DeepgramProviderOptions,
  language: string,
  factory: DeepgramSocketFactory,
  listeners: SpeechProviderListeners,
): SpeechProviderSession {
  let socket: DeepgramSocket | null = null;
  let closed = false;
  let opened = false;
  let stopping = false;
  let reported = false;
  // Audio that arrives during the upstream handshake. The session ack is
  // synchronous by design, so the first chunks of a turn always land here;
  // they are flushed in order once the socket opens.
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;
  const MAX_PENDING_BYTES = 4_000_000;

  const report = (error: SpeechProviderError): void => {
    if (closed || reported) return;
    reported = true;
    listeners.onError(error);
  };

  try {
    socket = factory(buildUrl(options, language), ["token", options.apiKey]);
  } catch {
    report({
      code: "provider_unavailable",
      message:
        "The server could not open a speech-provider connection in this runtime.",
      retryable: false,
    });
    return { push: () => {}, stop: () => {}, close: () => {} };
  }

  const live = socket;
  live.onopen = () => {
    opened = true;
    for (const chunk of pending) {
      if (closed) break;
      try {
        live.send(chunk);
      } catch {
        report(networkFailure);
        break;
      }
    }
    pending.length = 0;
    pendingBytes = 0;
  };
  live.onmessage = (event) => {
    if (closed) return;
    const parsed = readTranscript(event.data);
    if (!parsed) return;
    if (parsed.isFinal) listeners.onFinal(parsed.text);
    else listeners.onInterim(parsed.text);
  };
  // A handshake failure (bad key, unreachable host) fires before `open`, so
  // it is an auth/startup problem; anything after a successful open is a
  // dropped connection the user may retry by toggling the microphone.
  live.onerror = () => report(opened ? networkFailure : authFailure);
  live.onclose = () => {
    // Our own close, or the close that answers a graceful stop, is expected.
    // Any other upstream close leaves a dead microphone: surface it once.
    if (closed || stopping) return;
    report(networkFailure);
  };

  return {
    push(chunk) {
      if (closed) return;
      if (!opened) {
        if (pendingBytes + chunk.byteLength > MAX_PENDING_BYTES) {
          report(networkFailure);
          return;
        }
        pending.push(chunk);
        pendingBytes += chunk.byteLength;
        return;
      }
      try {
        live.send(chunk);
      } catch {
        report(networkFailure);
      }
    },
    stop() {
      if (closed) return;
      stopping = true;
      try {
        // Deepgram finalizes buffered audio when the stream is closed.
        live.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        /* nothing to flush */
      }
    },
    close() {
      closed = true;
      live.onopen = null;
      live.onmessage = null;
      live.onerror = null;
      live.onclose = null;
      try {
        live.close();
      } catch {
        /* already closed */
      }
    },
  };
}
