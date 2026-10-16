/**
 * Deepgram streaming adapter (recommended provider).
 *
 * ⚠️ NOT VERIFIED AGAINST THE LIVE SERVICE. No `DEEPGRAM_API_KEY` was available
 * when this was written, so the request URL, auth subprotocol, and response
 * parsing are implemented from Deepgram's documented streaming protocol and
 * covered only by a fake-socket unit test. Treat live recognition as
 * incomplete until it has been exercised with a real key and microphone.
 *
 * The API key stays on the server. The browser is never given a token; it
 * streams captured audio to our own Socket.IO server, which forwards it here.
 */
import type {
  SpeechProvider,
  SpeechProviderError,
  SpeechProviderListeners,
  SpeechProviderSession,
} from "./provider.js";

/** Languages Deepgram's current Nova models document for streaming. */
export const DEEPGRAM_LANGUAGES = ["en", "hi", "ta", "te"] as const;

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
  let reported = false;

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
  live.onopen = () => {};
  live.onmessage = (event) => {
    if (closed) return;
    const parsed = readTranscript(event.data);
    if (!parsed) return;
    if (parsed.isFinal) listeners.onFinal(parsed.text);
    else listeners.onInterim(parsed.text);
  };
  live.onerror = () => report(authFailure);
  live.onclose = () => {
    if (closed) return;
    listeners.onClose();
  };

  return {
    push(chunk) {
      if (closed) return;
      try {
        live.send(chunk);
      } catch {
        report(networkFailure);
      }
    },
    stop() {
      if (closed) return;
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
