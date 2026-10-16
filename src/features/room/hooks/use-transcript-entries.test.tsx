import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { TranscriptEntry } from "@/features/conversation/types";
import {
  useTranscriptEntries,
  type TranscriptEntriesApi,
} from "@/features/room/hooks/use-transcript-entries";
import { mountHook, type HookHarness } from "@/test/react-harness";

function row(sequence: number, id = `utt-${sequence}`): TranscriptEntry {
  return {
    utterance: {
      id,
      speakerSide: sequence % 2 === 0 ? "b" : "a",
      language: "ta",
      text: `line ${sequence}`,
      finalizedAt: 1_700_000_000_000 + sequence,
      sequence,
    },
    translation: { status: "unavailable" },
  };
}

const ids = (api: TranscriptEntriesApi) =>
  api.entries.map((entry) => entry.utterance.id);

let mounted: HookHarness<TranscriptEntriesApi, Record<string, never>>[] = [];

async function mount() {
  const harness = await mountHook(() => useTranscriptEntries(), {
    strict: false,
    props: {},
  });
  mounted.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of mounted) await harness.unmount();
  mounted = [];
});

describe("useTranscriptEntries", () => {
  it("appends a finalized utterance once and rejects a repeated id", async () => {
    const harness = await mount();
    await harness.perform(() => {
      assert.equal(harness.current().applyUtterance(row(1)), true);
      assert.equal(harness.current().applyUtterance(row(1)), false);
    });
    assert.deepEqual(ids(harness.current()), ["utt-1"]);
  });

  it("merges replayed history ahead of live rows, in sequence, without duplicates", async () => {
    const harness = await mount();
    await harness.perform(() => {
      harness.current().applyUtterance(row(3));
      // Replay overlaps the live row; the merge keeps one copy of each.
      harness.current().applyHistory([row(1), row(2), row(3)]);
    });
    assert.deepEqual(ids(harness.current()), ["utt-1", "utt-2", "utt-3"]);
  });

  it("treats an empty replay as a no-op", async () => {
    const harness = await mount();
    await harness.perform(() => harness.current().applyHistory([]));
    assert.deepEqual(ids(harness.current()), []);
  });

  it("does not resurrect a row the live path already stored", async () => {
    const harness = await mount();
    await harness.perform(() => harness.current().applyUtterance(row(2)));
    // A second reconnect replays the same row again; it must stay singular.
    await harness.perform(() => harness.current().applyHistory([row(2)]));
    assert.deepEqual(ids(harness.current()), ["utt-2"]);
  });
});
