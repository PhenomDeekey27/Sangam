/**
 * Presentation rules for the room's single playback control.
 *
 * The control exists for two jobs: stop what is playing, and give the browser
 * the user gesture it needs before it will start audio at all. Its enabled
 * state is therefore derived from the *room* (is this socket usable?), never
 * from the playback status: an idle, empty, parked, or failed queue must still
 * offer a working button, because those are exactly the states in which the
 * listener is waiting for audio and needs a way to ask for it.
 */
import type { PlaybackStatus } from "@/features/speech/types";

/** What a click on the playback control does. */
export type PlaybackAction = "stop" | "unlock";

export interface PlaybackControl {
  readonly label: string;
  /** Spoken description; states what the click will actually do. */
  readonly description: string;
  readonly action: PlaybackAction;
  /**
   * True only when the room itself cannot act (no connection, no seat). A
   * playback status never disables the control.
   */
  readonly disabled: boolean;
  /** True while translated audio is audible right now. */
  readonly active: boolean;
}

/**
 * Resolve the control for one playback status.
 *
 * @param status Current queue status.
 * @param roomUnavailable The room connection cannot be used (not joined).
 */
export function playbackControl(
  status: PlaybackStatus,
  roomUnavailable: boolean,
): PlaybackControl {
  if (status === "playing") {
    return {
      label: "Stop playback",
      description: "Stop the translated voice playing now",
      action: "stop",
      disabled: roomUnavailable,
      active: true,
    };
  }
  if (status === "error") {
    return {
      label: "Retry voice playback",
      description:
        "Play translated voice again — the last translation could not be played",
      action: "unlock",
      disabled: roomUnavailable,
      active: false,
    };
  }
  return {
    label: "Enable voice playback",
    description:
      status === "blocked"
        ? "Start translated voice playback — your browser needs one click first"
        : "Start translated voice playback when a translation arrives",
    action: "unlock",
    disabled: roomUnavailable,
    active: false,
  };
}
