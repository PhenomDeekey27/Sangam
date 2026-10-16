import type { LanguageCode } from "@/types";
import type { SpeechError } from "@/features/speech/types";

/**
 * Minimal structural types for the Web Speech API. TypeScript's DOM lib does
 * not declare `SpeechRecognition`, and the vendor-prefixed name differs per
 * browser, so the adapter depends only on the members Sangam actually uses.
 */
export interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}

export interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: SpeechRecognitionResultLike;
  };
}

export interface SpeechRecognitionErrorEventLike {
  readonly error: string;
}

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: ((event: Event) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: ((event: Event) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** Callbacks the adapter forwards from one recognition session. */
export interface RecognitionHandlers {
  /** Fired once when the browser's recognition service starts. */
  readonly onStart: () => void;
  /** Replaceable partial transcript; may fire many times per utterance. */
  readonly onInterim: (text: string) => void;
  /** One finalized transcript segment. */
  readonly onFinal: (text: string) => void;
  /** Recognition ended — either requested, or the browser gave up. */
  readonly onEnd: () => void;
  /** A recognition failure, already mapped to a Sangam error shape. */
  readonly onError: (error: SpeechError) => void;
}

/** A running recognition session the caller can stop or abort. */
export interface BrowserRecognition {
  start(): void;
  stop(): void;
  /** Terminate immediately without waiting for the service to wind down. */
  abort(): void;
}

/**
 * Map a `SpeechRecognitionErrorEvent.error` name to a Sangam speech error.
 * Every branch the browser can realistically report is answered with specific,
 * actionable copy — a dead microphone must never look like "nothing happened".
 */
export function mapRecognitionError(error: string): SpeechError {
  switch (error) {
    case "not-allowed":
      return {
        code: "permission_denied",
        message:
          "Microphone access was blocked — allow the microphone for this site in your browser settings, then try again.",
      };
    case "service-not-allowed":
      return {
        code: "permission_denied",
        message:
          "This browser blocked its speech recognition service. Type your message instead — Chrome, Edge, or Safari is recommended.",
      };
    case "audio-capture":
      return {
        code: "no_microphone",
        message: "No microphone was found — connect one and try again.",
      };
    case "network":
      return {
        code: "network",
        message:
          "Speech recognition lost its network connection — check your connection and try again. Browsers that block the speech service (for example Brave) may fail here; Chrome, Edge, or Safari is recommended.",
      };
    case "no-speech":
      return {
        code: "no_speech",
        message: "Didn't hear anything — keep speaking after the pause.",
      };
    case "language-not-supported":
      return {
        code: "language_not_supported",
        message:
          "This browser can't recognize that language — pick another speaking language, or type your message instead.",
      };
    case "audio-busy":
      return {
        code: "no_microphone",
        message:
          "Another app is using the microphone — close it, then turn the microphone on again.",
      };
    case "aborted":
      return { code: "aborted", message: "Speech recognition was stopped." };
    default:
      return {
        code: "unknown",
        message:
          "Speech recognition hit an unexpected problem — turn the microphone off and on again, or type your message instead.",
      };
  }
}

/** The browser's speech-recognition constructor, when one exists. */
export function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const scoped = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return scoped.SpeechRecognition ?? scoped.webkitSpeechRecognition ?? null;
}

/** True when this browser exposes a usable `SpeechRecognition` implementation. */
export function isSpeechRecognitionSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

/**
 * Create one recognition session for a language. The session runs
 * continuously with interim results enabled and never restarts itself —
 * lifecycle policy (auto-restart, throttling, deduplication) belongs to the
 * React hook above this adapter.
 */
export function createBrowserRecognition(
  language: LanguageCode,
  handlers: RecognitionHandlers,
): BrowserRecognition {
  const Ctor = getSpeechRecognitionCtor();
  /* c8 ignore next 3 -- callers feature-detect before creating */
  if (!Ctor) {
    throw new Error("Speech recognition is not supported in this browser.");
  }
  const recognition = new Ctor();
  recognition.lang = language;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    handlers.onStart();
  };

  recognition.onresult = (event) => {
    let interim: string | null = null;
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (!result) continue;
      const text = result[0]?.transcript ?? "";
      if (result.isFinal) {
        if (text.trim().length > 0) handlers.onFinal(text);
      } else {
        interim = text;
      }
    }
    if (interim !== null) handlers.onInterim(interim);
  };

  recognition.onerror = (event) => {
    handlers.onError(mapRecognitionError(event.error));
  };

  recognition.onend = () => {
    handlers.onEnd();
  };

  return {
    start: () => recognition.start(),
    stop: () => recognition.stop(),
    abort: () => recognition.abort(),
  };
}
