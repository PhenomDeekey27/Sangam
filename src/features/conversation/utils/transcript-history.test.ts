import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeTranscriptHistory } from "@/features/conversation/utils/transcript-history";
import type { TranscriptEntry } from "@/features/conversation/types";

function row(
  sequence: number,
  overrides: Partial<TranscriptEntry["utterance"]> = {},
): TranscriptEntry {
  return {
    utterance: {
      id: `utt-${sequence}`,
      speakerSide: sequence % 2 === 0 ? "b" : "a",
      language: "ta",
      text: `line ${sequence}`,
      finalizedAt: 1_700_000_000_000 + sequence,
      sequence,
      ...overrides,
    },
    translation: { status: "unavailable" },
  };
}

const ids = (entries: readonly TranscriptEntry[]) =>
  entries.map((entry) => entry.utterance.id);

describe("mergeTranscriptHistory", () => {
  it("returns the current rows untouched when there is nothing to replay", () => {
    const current = [row(1)];
    assert.equal(mergeTranscriptHistory(current, []), current);
  });

  it("replays older rows ahead of what is already on screen", () => {
    const merged = mergeTranscriptHistory([row(3)], [row(1), row(2)]);
    assert.deepEqual(ids(merged), ["utt-1", "utt-2", "utt-3"]);
  });

  it("never duplicates a row that appears in both the replay and the screen", () => {
    const merged = mergeTranscriptHistory([row(2), row(3)], [row(1), row(2)]);
    assert.deepEqual(ids(merged), ["utt-1", "utt-2", "utt-3"]);
  });

  it("orders replayed and live rows by the server's sequence", () => {
    // Live rows can arrive before the replay finishes; the merged transcript
    // must still read in conversation order.
    const merged = mergeTranscriptHistory(
      [row(4), row(5)],
      [row(1), row(2), row(3)],
    );
    assert.deepEqual(
      merged.map((entry) => entry.utterance.sequence),
      [1, 2, 3, 4, 5],
    );
  });

  it("keeps insert order for rows without a usable sequence", () => {
    const noSequence = (id: string): TranscriptEntry => ({
      utterance: { ...row(1).utterance, id, sequence: Number.NaN },
      translation: { status: "unavailable" },
    });
    const merged = mergeTranscriptHistory(
      [noSequence("live-a")],
      [noSequence("replayed-b")],
    );
    assert.deepEqual(ids(merged), ["replayed-b", "live-a"]);
  });

  it("preserves the original metadata of every replayed row", () => {
    const replayed = row(2, {
      speakerSide: "b",
      language: "hi",
      text: "Namaste",
    });
    const merged = mergeTranscriptHistory([], [replayed]);
    assert.deepEqual(merged[0], replayed);
    assert.equal(merged[0]?.translation.status, "unavailable");
  });

  it("does not mutate either input array", () => {
    const current = [row(3)];
    const history = [row(1), row(2)];
    mergeTranscriptHistory(current, history);
    assert.deepEqual(ids(current), ["utt-3"]);
    assert.deepEqual(ids(history), ["utt-1", "utt-2"]);
  });
});
