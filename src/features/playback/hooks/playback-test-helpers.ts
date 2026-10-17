/**
 * Shared scripted doubles for the playback-queue tests. Test-only: no browser
 * APIs, no timers — the tests decide exactly when a play resolves.
 */
import type { PlaybackPlayer } from "@/features/playback/hooks/use-playback-queue";
import type { PlayOutcome } from "@/features/playback/services/audio-player";
import type { PlaybackItem } from "@/features/playback/services/playback-queue";
import type { PlaybackPayload } from "@/types/socket";

export interface ScriptedPlayer {
  readonly player: PlaybackPlayer;
  readonly played: string[];
  readonly blocked: string[];
  /** Resolve every pending play with the given outcome. */
  resume(outcome?: PlayOutcome): void;
  /** Reject every pending play (corrupt audio, unsupported …). */
  failPending(): void;
  setNextOutcome(outcome: PlayOutcome): void;
}

/** A scripted player: play() awaits `resume()` before it resolves. */
export function createScriptedPlayer(): ScriptedPlayer {
  const played: string[] = [];
  const blocked: string[] = [];
  const waiters: Array<(outcome: PlayOutcome | "reject") => void> = [];
  let nextOutcome: PlayOutcome = "played";
  const release = (outcome: PlayOutcome | "reject") => {
    for (const waiter of waiters.splice(0)) waiter(outcome);
  };
  const player: PlaybackPlayer = {
    play(item: PlaybackItem, onStart?: () => void) {
      played.push(item.utteranceId);
      if (nextOutcome === "blocked") {
        // Autoplay refusal is known synchronously: the browser refuses to
        // start audio, so the hook learns "blocked" without any waiter and
        // no start is ever reported.
        blocked.push(item.utteranceId);
        nextOutcome = "played";
        return Promise.resolve<PlayOutcome>("blocked");
      }
      onStart?.();
      return new Promise<PlayOutcome>((resolve, reject) => {
        waiters.push((outcome) => {
          if (outcome === "reject") {
            reject(new Error("audio element error"));
            return;
          }
          resolve(outcome);
        });
      });
    },
    stop() {
      release("stopped");
    },
    dispose() {
      release("stopped");
    },
  };
  return {
    player,
    played,
    blocked,
    resume(outcome: PlayOutcome = "played") {
      release(outcome);
    },
    failPending() {
      release("reject");
    },
    setNextOutcome(outcome: PlayOutcome) {
      nextOutcome = outcome;
    },
  };
}

/** One playback delivery, already validated by the socket listener. */
export function payload(
  utteranceId: string,
  sequence: number,
): PlaybackPayload {
  return { utteranceId, sequence, language: "pa", mimeType: "audio/wav" };
}
