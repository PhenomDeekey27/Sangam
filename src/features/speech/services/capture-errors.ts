/**
 * Failures the capture lifecycle detects itself (as opposed to the ones the
 * browser reports through `SpeechRecognition.onerror`, mapped in
 * `web-speech.ts`). Each one states what happened and what to do next, because
 * a microphone that silently does nothing is indistinguishable from a bug.
 */
import type { SpeechError } from "@/features/speech/types";

/** The user blocked the microphone for this site. */
export const permissionDeniedError: SpeechError = {
  code: "permission_denied",
  message:
    "Microphone access was blocked — allow the microphone for this site in your browser settings, then try again.",
};

/** The browser found no usable input device. */
export const microphoneUnavailableError: SpeechError = {
  code: "unknown",
  message:
    "The microphone could not be started — check your input device and try again.",
};

/** No input device exists (as opposed to a generic start failure). */
export const noMicrophoneError: SpeechError = {
  code: "no_microphone",
  message:
    "No microphone was found — connect one and try again, or type your message.",
};

/** The input device is present but could not be read (usually a busy device). */
export const microphoneBusyError: SpeechError = {
  code: "no_microphone",
  message:
    "Another app is using the microphone — close it, then turn the microphone on again.",
};

/**
 * Map a `getUserMedia` rejection to a Sangam speech error. Audio capture is a
 * separate step from recognition, so its failures need their own honest copy.
 */
export function errorForMicFailure(cause: unknown): SpeechError {
  const name = cause instanceof DOMException ? cause.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return permissionDeniedError;
    case "NotFoundError":
    case "DevicesNotFoundError":
      return noMicrophoneError;
    case "NotReadableError":
    case "TrackStartError":
      return microphoneBusyError;
    case "OverconstrainedError":
      return noMicrophoneError;
    default:
      return microphoneUnavailableError;
  }
}

/** The session started but never reported that it was listening. */
export const microphoneNeverStartedError: SpeechError = {
  code: "unknown",
  message:
    "The microphone never started — check that no other app is using it, then try again.",
};

/** Sessions that end before hearing anything, over and over. */
export const recognitionKeptStoppingError: SpeechError = {
  code: "unexpected_end",
  message:
    "Speech recognition kept stopping before hearing anything — check your microphone, then try again.",
};

/**
 * Failure for a `start()` that threw: a denied permission is reported as such,
 * anything else (a busy device, an invalid state) as a start problem.
 */
export function errorForStartFailure(cause: unknown): {
  readonly error: SpeechError;
  readonly permissionDenied: boolean;
} {
  const name = cause instanceof DOMException ? cause.name : "";
  return name === "NotAllowedError"
    ? { error: permissionDeniedError, permissionDenied: true }
    : { error: microphoneUnavailableError, permissionDenied: false };
}
