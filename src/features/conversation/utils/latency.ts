/**
 * Development-only latency instrumentation for the translated-speech pipeline.
 *
 * One utterance id travels from capture to playback, so the same id keys every
 * stage a single client can observe:
 *
 *   final        server-stamped `finalizedAt` (ms epoch) from the transcript row
 *   utterance    this client received `conversation:utterance`
 *   translation  this client received `conversation:translation`
 *   audio        this client received `conversation:playback` (binary frame)
 *   playback     the audio element actually began playing
 *
 * The tracker keeps only ids and timestamps — never transcript text, audio, or
 * secrets — and the logger is compiled out of production builds. It exists to
 * *find* the slowest leg before any behaviour is changed; it never influences
 * playback, ordering, or interruption.
 */

/** One observable point in an utterance's round trip. */
export type LatencyStage =
  "final" | "utterance" | "translation" | "audio" | "playback";

/** First timestamp recorded for each stage of one utterance. */
export interface LatencyMarks {
  readonly final?: number;
  readonly utterance?: number;
  readonly translation?: number;
  readonly audio?: number;
  readonly playback?: number;
}

/** The derived gaps between an utterance's recorded stages. */
export interface LatencyReport {
  readonly utteranceId: string;
  readonly marks: LatencyMarks;
  /** Broadcast → translated text on this client (translation leg). */
  readonly translationMs: number | null;
  /** Translated text → synthesized audio on this client (TTS leg). */
  readonly ttsMs: number | null;
  /** Audio delivered → first sound (client scheduling + element startup). */
  readonly playbackMs: number | null;
  /** Listener-perceived: broadcast → first sound. */
  readonly totalMs: number | null;
  /**
   * Server finalize stamp → first sound. This compares the server clock to the
   * client clock, so it is exact only when both share one machine (localhost
   * development); everywhere else treat it as a cross-clock hint.
   */
  readonly serverToPlaybackMs: number | null;
}

export interface LatencyClock {
  now(): number;
}

/** Internal mutable store; the public marks view is readonly. */
type MarkStore = Partial<Record<LatencyStage, number>>;

export interface LatencyTrackerOptions {
  readonly clock?: LatencyClock;
  /** Upper bound on tracked utterances; the oldest are evicted first. */
  readonly maxEntries?: number;
}

export const DEFAULT_LATENCY_ENTRIES = 64;

/**
 * Per-utterance stage marks with first-write-wins semantics, so a duplicated
 * socket frame can never move a stage's timestamp. Bounded so a long session
 * cannot grow it without limit.
 */
export class LatencyTracker {
  private readonly clock: LatencyClock;
  private readonly maxEntries: number;
  private readonly marks = new Map<string, MarkStore>();

  constructor(options: LatencyTrackerOptions = {}) {
    this.clock = options.clock ?? { now: () => Date.now() };
    this.maxEntries =
      typeof options.maxEntries === "number" && options.maxEntries > 0
        ? Math.floor(options.maxEntries)
        : DEFAULT_LATENCY_ENTRIES;
  }

  /** Record one stage the first time it is reported. */
  mark(utteranceId: string, stage: LatencyStage, atMs?: number): void {
    if (!utteranceId) return;
    let entry = this.marks.get(utteranceId);
    if (!entry) {
      entry = {};
      this.marks.set(utteranceId, entry);
      this.evict();
    }
    if (entry[stage] === undefined) {
      entry[stage] = atMs ?? this.clock.now();
    }
  }

  /** Current derived gaps for one utterance, or `null` when never marked. */
  report(utteranceId: string): LatencyReport | null {
    const marks = this.marks.get(utteranceId);
    if (!marks) return null;
    return summarize(utteranceId, marks);
  }

  /** Report one utterance and forget it (called once its audio started). */
  finish(utteranceId: string): LatencyReport | null {
    const report = this.report(utteranceId);
    this.marks.delete(utteranceId);
    return report;
  }

  /** Forget every tracked utterance. */
  clear(): void {
    this.marks.clear();
  }

  private evict(): void {
    while (this.marks.size > this.maxEntries) {
      const oldest = this.marks.keys().next().value;
      if (oldest === undefined) return;
      this.marks.delete(oldest);
    }
  }
}

/** The process-wide tracker the client instrumentation writes to. */
export const latencyTracker = new LatencyTracker();

/** Record one observed stage on the shared tracker. */
export function markLatency(
  utteranceId: string,
  stage: LatencyStage,
  atMs?: number,
): void {
  latencyTracker.mark(utteranceId, stage, atMs);
}

/**
 * Mark a transcript row this client received: the server's finalize stamp
 * (when present) plus local receipt. Safe for a partial/legacy entry — a
 * missing stamp simply leaves the server-side reference unset.
 */
export function markUtteranceReceived(entry: {
  readonly utterance: { readonly id: string; readonly finalizedAt?: number };
}): void {
  const id = entry.utterance.id;
  markLatency(id, "utterance");
  const finalizedAt = entry.utterance.finalizedAt;
  if (typeof finalizedAt === "number" && Number.isFinite(finalizedAt)) {
    markLatency(id, "final", finalizedAt);
  }
}

/**
 * Mark the moment audio actually began, then log and forget the utterance.
 * Called from the playback path only after the element accepted playback, so
 * a blocked or interrupted attempt never reports a false start.
 */
export function recordPlaybackStart(utteranceId: string): void {
  markLatency(utteranceId, "playback");
  const report = latencyTracker.finish(utteranceId);
  if (report) logLatency(report);
}

/** Forget every tracked utterance; used when the listening context changes. */
export function resetLatency(): void {
  latencyTracker.clear();
}

/**
 * Emit one safe structured line describing where an utterance spent its time.
 * Contains ids and millisecond gaps only, and is skipped in production.
 */
export function logLatency(report: LatencyReport): void {
  if (process.env.NODE_ENV === "production") return;
  console.debug(
    `[sangam] latency ${report.utteranceId} ` +
      `translate=${formatMs(report.translationMs)} ` +
      `tts=${formatMs(report.ttsMs)} ` +
      `start=${formatMs(report.playbackMs)} ` +
      `total=${formatMs(report.totalMs)} ` +
      `serverToStart=${formatMs(report.serverToPlaybackMs)}`,
  );
}

function summarize(utteranceId: string, marks: LatencyMarks): LatencyReport {
  return {
    utteranceId,
    marks: { ...marks },
    translationMs: gap(marks.utterance, marks.translation),
    ttsMs: gap(marks.translation, marks.audio),
    playbackMs: gap(marks.audio, marks.playback),
    totalMs: gap(marks.utterance, marks.playback),
    serverToPlaybackMs: gap(marks.final, marks.playback),
  };
}

/** A non-negative, whole-millisecond gap, or `null` when either end is absent. */
function gap(from: number | undefined, to: number | undefined): number | null {
  if (from === undefined || to === undefined) return null;
  return Math.max(0, Math.round(to - from));
}

function formatMs(value: number | null): string {
  return value === null ? "?" : `${value}ms`;
}
