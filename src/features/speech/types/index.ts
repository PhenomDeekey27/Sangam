/** Whether microphone access has been granted by the browser. */
export type MicPermission = "granted" | "denied" | "prompt" | "unavailable";

/** Status of the browser speech recognition session. */
export type RecognitionStatus =
  "idle" | "starting" | "listening" | "stopping" | "error";

/** Status of translated-speech playback. */
export type PlaybackStatus = "idle" | "playing" | "stopped" | "error";

/** Machine-readable reasons a speech capability can fail. */
export type SpeechErrorCode =
  | "not_supported"
  | "permission_denied"
  | "no_microphone"
  | "no_speech"
  | "network"
  | "aborted"
  | "unknown";

/** A speech failure, with enough detail for an inline message. */
export interface SpeechError {
  readonly code: SpeechErrorCode;
  readonly message: string;
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
