/** Whether microphone access has been granted by the browser. */
export type MicPermission = "granted" | "denied" | "prompt" | "unavailable";

/**
 * Whether this browser can run speech recognition at all. `checking` is the
 * server-render/hydration answer: feature detection needs a browser, so the
 * app must not claim "unsupported" before the client has looked.
 */
export type SpeechSupport = "checking" | "supported" | "unsupported";

/** Status of the browser speech recognition session. */
export type RecognitionStatus =
  "idle" | "starting" | "listening" | "stopping" | "error";

/**
 * Where recognition actually runs for the current session:
 * - `server` — audio streams to the Sangam server's provider (browser-agnostic).
 * - `browser` — the browser's own Web Speech API (deliberate fallback, with
 *               the known per-browser limitations).
 * - `none` — no pipeline is available; the text composer remains.
 */
export type SpeechTransport = "server" | "browser" | "none";

/**
 * Status of translated-speech playback. `blocked` means the browser refused
 * to start audio (autoplay policy) and playback is parked until a user
 * gesture unlocks it.
 */
export type PlaybackStatus =
  | "idle"
  | "playing"
  | "stopped"
  | "blocked"
  | "error";

/** Machine-readable reasons a speech capability can fail. */
export type SpeechErrorCode =
  | "not_supported"
  | "permission_denied"
  | "no_microphone"
  | "no_speech"
  | "network"
  | "language_not_supported"
  | "unexpected_end"
  | "aborted"
  | "provider_unavailable"
  | "provider_auth"
  | "provider_network"
  | "audio_too_large"
  | "speech_unavailable"
  | "language_mismatch"
  | "unknown";

/** A speech failure, with enough detail for an inline message. */
export interface SpeechError {
  readonly code: SpeechErrorCode;
  readonly message: string;
}

/**
 * Common control surface shared by the browser and server capture pipelines, so
 * the React hook can drive either one without knowing which engine is behind it.
 */
export interface CaptureController {
  /** True while capture is wanted (starting, listening, draining). */
  readonly running: boolean;
  start(): void;
  stop(): void;
  /** Release everything: no callback fires after this returns. */
  dispose(): void;
  /** Follow a new speaking language. */
  setLanguage(language: string): void;
}

/** Recognition session state; the error payload only exists on failure. */
export type RecognitionState =
  | {
      readonly status: Exclude<RecognitionStatus, "error">;
      readonly permission: MicPermission;
    }
  | {
      readonly status: "error";
      readonly permission: MicPermission;
      readonly error: SpeechError;
    };

/** Playback session state; the error payload only exists on failure. */
export type PlaybackState =
  | { readonly status: Exclude<PlaybackStatus, "error"> }
  | { readonly status: "error"; readonly error: SpeechError };
