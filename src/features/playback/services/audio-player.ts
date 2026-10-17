import type { PlaybackItem } from "./playback-queue";
import {
  describePlaybackError,
  logPlaybackDiagnostic,
} from "@/features/playback/utils/playback-diagnostics";

/**
 * The browser side of Stage-6 playback: turn one binary audio frame into a
 * Blob URL, play it on an `<audio>` element, and clean up every object URL.
 *
 * Design constraints carried over from the requirements:
 * - Never hangs or throws on failure: `play` resolves with an outcome the
 *   queue can act on ("played", "stopped", "blocked") and rejects only on
 *   genuine element failures — the translated text row is never lost to an
 *   audio problem.
 * - Autoplay-aware: a `NotAllowedError` resolves as `"blocked"` instead of
 *   an error, so the caller can park the queue until a user gesture.
 * - Cleanup-aware: the object URL is revoked exactly when playback ends, is
 *   stopped, fails, or the player is disposed.
 * - Cancel-ready (Stage 7): `stop()` and `dispose()` immediately mute and
 *   release whatever is active; no callback fires afterwards.
 */

/** What one `play` attempt concluded. */
export type PlayOutcome = "played" | "blocked" | "stopped";

/** The single media element surface the player needs. */
export interface MediaElement {
  src: string;
  play(): Promise<void>;
  pause(): void;
  addEventListener(
    type: "ended" | "error",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: "ended" | "error", listener: () => void): void;
}

export type MediaElementFactory = () => MediaElement;

export interface AudioPlayerOptions {
  /** Injectable element factory; defaults to a real `Audio`. */
  readonly createElement?: MediaElementFactory;
  /** Injectable blob-URL layer for deterministic tests. */
  readonly createObjectUrl?: (blob: Blob) => string;
  readonly revokeObjectUrl?: (url: string) => void;
}

/** One active playback attempt: element, URL, and its settle channel. */
interface PlaySession {
  readonly element: MediaElement;
  readonly url: string;
  readonly finish: (outcome: PlayOutcome, failure?: unknown) => void;
}

export class AudioPlayer {
  private readonly createElement: MediaElementFactory;
  private readonly createObjectUrl: (blob: Blob) => string;
  private readonly revokeObjectUrl: (url: string) => void;
  private session: PlaySession | null = null;
  private stopped = false;
  private disposed = false;

  constructor(options: AudioPlayerOptions = {}) {
    this.createElement = options.createElement ?? (() => new Audio());
    this.createObjectUrl =
      options.createObjectUrl ??
      ((blob: Blob) => {
        if (typeof URL.createObjectURL !== "function") {
          throw new Error(ATTRIBUTE_ERROR);
        }
        return URL.createObjectURL(blob);
      });
    this.revokeObjectUrl =
      options.revokeObjectUrl ??
      ((url: string) => {
        if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
      });
  }

  /**
   * Play one queued item to completion. Resolves `"played"` after `ended`,
   * `"blocked"` when the browser refused to start (autoplay policy), and
   * `"stopped"` when `stop`/`dispose` interrupted it. Rejects only on real
   * element/play failures (corrupt audio, unsupported type, …).
   *
   * `onStart` fires once, at the moment the element actually began playing
   * (after `play()` resolves and only if no stop arrived first) — never for a
   * blocked or cancelled attempt. It is a diagnostics hook and cannot affect
   * the outcome.
   */
  play(item: PlaybackItem, onStart?: () => void): Promise<PlayOutcome> {
    if (this.disposed) {
      return Promise.reject(new Error("audio player is disposed"));
    }
    if (this.session) {
      return Promise.reject(new Error("audio player is already playing"));
    }
    return new Promise<PlayOutcome>((resolve, reject) => {
      this.stopped = false;
      const element = this.createElement();
      const url = this.createObjectUrl(
        new Blob([item.audio], { type: item.mimeType || "audio/wav" }),
      );
      element.src = url;
      let settled = false;
      const finish = (outcome: PlayOutcome, failure?: unknown): void => {
        if (settled) return;
        settled = true;
        this.session = null;
        element.removeEventListener("ended", onEnded);
        element.removeEventListener("error", onError);
        element.pause();
        this.revokeObjectUrl(url);
        if (failure === undefined) resolve(outcome);
        else reject(failure);
      };
      const onEnded = () => finish("played");
      const onError = () =>
        finish(
          this.stopped ? "stopped" : "played",
          new Error("audio element error"),
        );
      element.addEventListener("ended", onEnded, { once: true });
      element.addEventListener("error", onError, { once: true });
      this.session = { element, url, finish };
      // A stop()/dispose() that arrives mid-startup resolves instead of
      // hanging, because `ended` never fires after a pause().
      element
        .play()
        .then(() => {
          if (this.stopped) {
            finish("stopped");
            return;
          }
          // The element accepted playback: this is the "first audio" moment.
          // A throwing diagnostics hook must never break playback.
          try {
            onStart?.();
          } catch {
            /* diagnostics only */
          }
        })
        .catch((error: unknown) => {
          const failure = describePlaybackError(error);
          if (this.stopped) {
            finish("stopped");
          } else if (isAutoplayRefusal(error)) {
            logPlaybackDiagnostic({
              stage: "outcome",
              utteranceId: item.utteranceId,
              sequence: item.sequence,
              bytes: item.audio.byteLength,
              mimeType: item.mimeType,
              status: "blocked",
              reason: "autoplay_refusal",
              errorName: failure.name,
              errorMessage: failure.message,
            });
            finish("blocked");
          } else {
            // The real element rejection, logged before it is rethrown so a
            // "no audio, no error" symptom can never hide its cause.
            logPlaybackDiagnostic({
              stage: "failure",
              utteranceId: item.utteranceId,
              sequence: item.sequence,
              bytes: item.audio.byteLength,
              mimeType: item.mimeType,
              status: "error",
              reason: "element_play_rejected",
              errorName: failure.name,
              errorMessage: failure.message,
            });
            finish("played", error);
          }
        });
    });
  }

  /**
   * Mute and release the active item immediately. The in-flight `play`
   * resolves `"stopped"`; a later `play` may start fresh.
   */
  stop(): void {
    this.stopped = true;
    this.session?.finish("stopped");
  }

  /** Release everything; no callback fires after this returns. */
  dispose(): void {
    this.disposed = true;
    this.stop();
  }
}

/** Only an autoplay-policy refusal parks playback; anything else is failure. */
function isAutoplayRefusal(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  return (error as { name?: unknown }).name === "NotAllowedError";
}

const ATTRIBUTE_ERROR = "NotSupportedError";
