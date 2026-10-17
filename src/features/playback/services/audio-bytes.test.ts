import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeAudioBytes } from "@/features/playback/services/audio-bytes";

describe("normalizeAudioBytes", () => {
  it("passes an ArrayBuffer through unchanged", () => {
    const buffer = new ArrayBuffer(8);
    assert.equal(normalizeAudioBytes(buffer, () => undefined), buffer);
  });

  it("copies only the view's window of a typed array", () => {
    const view = new Uint8Array([1, 2, 3, 4, 5]).subarray(1, 4);
    const bytes = normalizeAudioBytes(view, () => undefined);
    assert.ok(bytes instanceof ArrayBuffer);
    assert.deepEqual([...new Uint8Array(bytes)], [2, 3, 4]);
  });

  it("resolves a Blob asynchronously through the callback", async () => {
    const captured: ArrayBuffer[] = [];
    const immediate = normalizeAudioBytes(
      new Blob([new Uint8Array([9, 9])]),
      (bytes) => {
        captured.push(bytes);
      },
    );
    assert.equal(immediate, null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(captured.length, 1);
    const first = captured[0];
    assert.ok(first);
    assert.deepEqual([...new Uint8Array(first)], [9, 9]);
  });

  it("treats anything else as unusable rather than throwing", () => {
    assert.equal(normalizeAudioBytes(null, () => undefined), null);
    assert.equal(normalizeAudioBytes("audio", () => undefined), null);
    assert.equal(normalizeAudioBytes({}, () => undefined), null);
  });
});
