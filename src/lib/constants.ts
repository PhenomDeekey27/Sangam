/** Route prefix for conversation rooms: the screen lives at `/room/[code]`. */
export const ROOM_ROUTE_PREFIX = "/room";

/**
 * Shown wherever the UI must be honest about what this stage does and does not
 * do: typed messages relay through the local server; voice, translation, and
 * audio playback are later stages.
 */
export const PREVIEW_STAGE_NOTE =
  "Typed messages relay through your local Sangam server. Voice input, translation, and audio playback arrive in later stages.";

/** Minimum interactive target size in CSS pixels (Sangam accessibility rule). */
export const MIN_TOUCH_TARGET_PX = 44;

/** Preferred microphone control size in CSS pixels (Sangam accessibility rule). */
export const MIC_CONTROL_PX = 56;
