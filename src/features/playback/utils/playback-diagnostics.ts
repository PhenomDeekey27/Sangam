/**
 * TEMPORARY development-only diagnostics for the translated-speech playback
 * path, added to locate a regression where audio silently stopped reaching the
 * browser while the translated text stayed on screen.
 *
 * Each line carries a stage name, the utterance id/sequence, byte length +
 * MIME, the queue state, and — on failure — the browser's own error name and a
 * length-bounded message. It never logs transcript text, audio bytes, API keys,
 * or tokens, and the `NODE_ENV` guard compiles it out of production.
 *
 * Remove this module (and its call sites) once the regression is confirmed.
 */

/** One observed point in the socket → queue → player playback trace. */
export type PlaybackDiagnosticStage =
  | "intake" // a delivery reached the hook (bytes + MIME known)
  | "queue_discard" // the queue refused it (stale, duplicate, or overflow)
  | "start" // the element accepted playback ("first sound")
  | "outcome" // one attempt settled: played / blocked / stopped
  | "failure" // a genuine `play()` rejection
  | "state"; // the drain finished and reported a terminal state

export interface PlaybackDiagnostic {
  readonly stage: PlaybackDiagnosticStage;
  readonly utteranceId?: string;
  readonly sequence?: number;
  readonly bytes?: number;
  readonly mimeType?: string;
  /** `queued`/`discarded`/`playing`/`played`/`blocked`/`stopped`/an error. */
  readonly status?: string;
  /** Why: `stale_duplicate_or_overflow`, `play_rejected`, a stop reason, … */
  readonly reason?: string;
  /** The thrown value's `name` (e.g. `NotAllowedError`, `NotSupportedError`). */
  readonly errorName?: string;
  /** A length-bounded slice of the thrown value's `message`. */
  readonly errorMessage?: string;
}

/** Log one playback diagnostic to the dev console; a no-op in production. */
export function logPlaybackDiagnostic(detail: PlaybackDiagnostic): void {
  if (process.env.NODE_ENV === "production") return;
  const parts: string[] = [`stage=${detail.stage}`];
  if (detail.utteranceId) parts.push(`utterance=${detail.utteranceId}`);
  if (detail.sequence !== undefined) parts.push(`sequence=${detail.sequence}`);
  if (detail.bytes !== undefined) parts.push(`bytes=${detail.bytes}`);
  if (detail.mimeType) parts.push(`mime=${detail.mimeType}`);
  if (detail.status) parts.push(`status=${detail.status}`);
  if (detail.reason) parts.push(`reason=${detail.reason}`);
  if (detail.errorName) parts.push(`error=${detail.errorName}`);
  if (detail.errorMessage) {
    parts.push(`message="${detail.errorMessage.slice(0, 140)}"`);
  }
  console.debug(`[sangam] playback ${parts.join(" ")}`);
}

/** Concise, length-bounded description of an unknown thrown value. */
export function describePlaybackError(error: unknown): {
  readonly name: string;
  readonly message: string;
} {
  if (error instanceof Error) {
    return { name: error.name || "Error", message: error.message || "" };
  }
  if (typeof error === "object" && error !== null && "name" in error) {
    const name = String((error as { name?: unknown }).name ?? "Error");
    const raw = (error as { message?: unknown }).message;
    return { name, message: typeof raw === "string" ? raw : "" };
  }
  return { name: typeof error, message: "" };
}
