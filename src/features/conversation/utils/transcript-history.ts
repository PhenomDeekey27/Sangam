import type { TranscriptEntry } from "@/features/conversation/types";

/**
 * Merge replayed room history into the rows already on screen.
 *
 * Members reconnect on a fresh socket, so the server replays the room's
 * retained transcript to their new seat. That replay overlaps whatever this
 * client already rendered (its own previous rows, or rows received before the
 * replay), so the merge must:
 *
 * - key on the server-assigned utterance id, keeping the first copy of a row
 *   that appears on both sides (never a duplicate),
 * - order by the server's per-room `sequence`, so replayed rows land ahead of
 *   anything received afterwards and a reordered delivery cannot shuffle the
 *   conversation,
 * - stay stable for entries missing a sequence (older payloads).
 */
export function mergeTranscriptHistory(
  current: readonly TranscriptEntry[],
  history: readonly TranscriptEntry[],
): readonly TranscriptEntry[] {
  if (history.length === 0) return current;

  const seen = new Set<string>();
  const merged: TranscriptEntry[] = [];
  for (const entry of [...history, ...current]) {
    const id = entry.utterance.id;
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(entry);
  }

  return merged.sort((left, right) => sequenceOf(left) - sequenceOf(right));
}

/** Server ordering stamp; rows without one sort first and keep their order. */
function sequenceOf(entry: TranscriptEntry): number {
  const sequence = entry.utterance.sequence;
  return Number.isFinite(sequence) ? sequence : 0;
}
