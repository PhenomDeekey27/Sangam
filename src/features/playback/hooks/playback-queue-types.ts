/**
 * Public types of the translated-speech playback queue. They live apart from
 * `use-playback-queue` so both the hook and the room wiring can name them
 * without importing the hook's runtime (and so the hook stays inside the
 * repository's file-length budget).
 */
import type { PlaybackState } from "@/features/speech/types";
import type { PlaybackPayload } from "@/types/socket";
import type { LanguageCode } from "@/types";
import type { PlayOutcome } from "@/features/playback/services/audio-player";
import type { PlaybackItem } from "@/features/playback/services/playback-queue";

/** The playable surface the hook drives; injectable for tests. */
export interface PlaybackPlayer {
  play(item: PlaybackItem, onStart?: () => void): Promise<PlayOutcome>;
  stop(): void;
  dispose(): void;
}

export interface PlaybackQueueOptions {
  readonly capacity?: number;
  /** Injectable player; defaults to a real browser `AudioPlayer`. */
  readonly createPlayer?: () => PlaybackPlayer;
  /** Report playback states to the room's shared `aria-live` region. */
  readonly onNotice?: (message: string | null) => void;
  /**
   * Development-only: fired once per item, at the instant its audio actually
   * began (never for a blocked or interrupted attempt). Used for latency
   * instrumentation; it cannot affect playback.
   */
  readonly onPlaybackStart?: (utteranceId: string, sequence: number) => void;
}

/** The translated-audio item actually playing right now, if any. */
export interface NowPlaying {
  readonly utteranceId: string;
  readonly sequence: number;
  /** The audio's language (the listener's target), not the speaker's. */
  readonly language: LanguageCode;
}

export interface PlaybackQueueHook {
  readonly state: PlaybackState;
  /** The item making sound right now; `null` when nothing is playing. */
  readonly nowPlaying: NowPlaying | null;
  /** Accept one server delivery; drops duplicates and stale arrivals. */
  readonly enqueue: (payload: PlaybackPayload, audio: ArrayBuffer) => void;
  /** Manual stop: mute the active item and discard the whole queue. */
  readonly stop: () => void;
  /**
   * Resume playback from a real user gesture. Browsers refuse `play()` until
   * the document has seen one interaction, so this must be called straight from
   * a click or key handler. It leaves a parked (`blocked`) or failed (`error`)
   * session and drains whatever is still queued; with an empty queue it is a
   * harmless no-op. It is never disabled: it is the one action that must stay
   * available exactly when playback status says nothing is playing.
   */
  readonly unlock: () => void;
  /**
   * Remote interruption (Stage 7). `sequence` is the server's boundary: mute
   * the active item, discard queued audio for that turn or older, reject late
   * frames for it, and keep playing anything above it (new speech).
   */
  readonly interrupt: (sequence: number) => void;
  /**
   * Stop and forget all playback. Used when the listening context changes
   * (room change, disconnect, teardown) so no stale audio or watermark
   * survives into the next context.
   */
  readonly reset: () => void;
}
