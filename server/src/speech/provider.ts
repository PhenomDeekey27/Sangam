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

/**
 * Optional metadata a provider may attach to a finalized segment. Only the
 * fields the provider actually reports are populated; a provider that cannot
 * detect language (for example a streaming vendor pinned to one locale)
 * simply omits this second argument.
 */
export interface SpeechFinalMetadata {
  /** BCP-47 primary subtag the provider detected, or `null` when unknown. */
  readonly detectedLanguage: string | null;
  /** 0..1 confidence in the detected language, or `null` when unreported. */
  readonly confidence: number | null;
}

/** Callbacks a provider session pushes results through. */
export interface SpeechProviderListeners {
  /** Replaceable partial transcript; called many times per utterance. */
  readonly onInterim: (text: string) => void;
  /** One finalized transcript segment, with optional detection metadata. */
  readonly onFinal: (text: string, metadata?: SpeechFinalMetadata) => void;
  readonly onError: (error: SpeechProviderError) => void;
  /** The upstream connection closed (gracefully or not). */
  readonly onClose: () => void;
}

/** Options for opening one session. */
export interface SpeechProviderOpenOptions extends SpeechProviderListeners {
  /** BCP-47 primary subtag the speaker selected, e.g. `"ta"`. */
  readonly language: string;
  /**
   * Container/codec of the captured chunks (`audio/webm`, `audio/ogg`, …),
   * already validated by the caller. Providers that batch the turn upstream
   * need it to label the upload; streaming providers may ignore it.
   */
  readonly mimeType?: string;
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
  /**
   * True when a session consumes a live audio stream (chunks pushed as they
   * are captured). A provider may buffer that stream internally and batch it
   * upstream — `interim` reports whether replaceable partial text is produced
   * while the stream is open.
   */
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
