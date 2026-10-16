/**
 * Speech-to-text provider boundary.
 *
 * The server owns recognition so the browser only has to capture audio: no
 * vendor SDK runs in the page and no credential is ever shipped to it. A
 * provider is opened per speaking turn, handed raw audio chunks, and reports
 * interim/final transcripts plus structured failures. Concrete adapters
 * (`mock`, `deepgram`) live beside this file; nothing else in the app knows
 * which vendor is in use.
 */
import type { SpeechProviderId } from "../../../src/types/socket.js";

/** A provider failure, already safe to relay to a client. */
export interface SpeechProviderError {
  readonly code: string;
  readonly message: string;
  /** A retryable failure may be surfaced as "try again"; fatal ones are not. */
  readonly retryable: boolean;
}

/** Callbacks a provider session pushes results through. */
export interface SpeechProviderListeners {
  /** Replaceable partial transcript; called many times per utterance. */
  readonly onInterim: (text: string) => void;
  /** One finalized transcript segment. */
  readonly onFinal: (text: string) => void;
  readonly onError: (error: SpeechProviderError) => void;
  /** The upstream connection closed (gracefully or not). */
  readonly onClose: () => void;
}

/** Options for opening one session. */
export interface SpeechProviderOpenOptions extends SpeechProviderListeners {
  /** BCP-47 primary subtag the speaker selected, e.g. `"ta"`. */
  readonly language: string;
}

/** A live recognition session. */
export interface SpeechProviderSession {
  /** Feed captured audio. The provider owns all buffering. */
  readonly push: (chunk: Uint8Array) => void;
  /** Graceful stop: a final segment may still arrive. */
  readonly stop: () => void;
  /** Immediate teardown; no event may fire after this returns. */
  readonly close: () => void;
}

/** One speech-to-text engine. */
export interface SpeechProvider {
  readonly id: SpeechProviderId;
  /** True when live audio can be streamed (vs. whole-file batches). */
  readonly streaming: boolean;
  /** True when replaceable interim text is produced. */
  readonly interim: boolean;
  /** Languages this engine accepts (BCP-47 primary subtags). */
  readonly languages: readonly string[];
  /**
   * Open a session. Synchronous by design: connection work happens in the
   * background and a failure arrives through `onError`, mirroring how browser
   * recognition reports itself.
   */
  readonly open: (options: SpeechProviderOpenOptions) => SpeechProviderSession;
}

/** A provider that is not configured refuses every open. */
export interface UnconfiguredProvider extends SpeechProvider {
  readonly id: "none";
}
