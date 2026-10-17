import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PlaybackQueue,
  type PlaybackItem,
} from "@/features/playback/services/playback-queue";

function item(
  utteranceId: string,
  sequence: number,
  bytes = 8,
): PlaybackItem {
  return {
    utteranceId,
    sequence,
    language: "pa",
    mimeType: "audio/wav",
    audio: new ArrayBuffer(bytes),
  };
}

describe("PlaybackQueue", () => {
  it("hands items out in sequence order regardless of arrival", () => {
    const queue = new PlaybackQueue();
    assert.equal(queue.enqueue(item("b", 2)), true);
    assert.equal(queue.enqueue(item("a", 1)), true);
    assert.equal(queue.size, 2);
    assert.equal(queue.next()?.utteranceId, "a");
    queue.markPlayed(item("a", 1));
    assert.equal(queue.next()?.utteranceId, "b");
    queue.markPlayed(item("b", 2));
    assert.equal(queue.next(), null);
    assert.equal(queue.playedUpTo, 2);
  });

  it("drops a repeated utterance id on either path", () => {
    const queue = new PlaybackQueue();
    assert.equal(queue.enqueue(item("u1", 1)), true);
    // Queued duplicate (server replay)…
    assert.equal(queue.enqueue(item("u1", 1)), false);
    // …and a duplicate after it already played.
    queue.markPlayed(item("u1", 1));
    assert.equal(queue.enqueue(item("u1", 1)), false);
    assert.equal(queue.size, 0);
  });

  it("drops stale late arrivals once a newer message has played", () => {
    const queue = new PlaybackQueue();
    queue.markPlayed(item("u9", 9));
    assert.equal(queue.enqueue(item("u4", 4)), false);
    assert.equal(queue.enqueue(item("u9", 9)), false);
    assert.equal(queue.enqueue(item("u10", 10)), true);
  });

  it("clears everything queued but keeps the played watermark", () => {
    const queue = new PlaybackQueue();
    queue.markPlayed(item("u2", 2));
    queue.enqueue(item("u3", 3));
    queue.enqueue(item("u4", 4));
    queue.clear();
    assert.equal(queue.size, 0);
    assert.equal(queue.playedUpTo, 2);
    // A late duplicate of a pre-clear sequence stays dead; a live one plays.
    assert.equal(queue.enqueue(item("u1", 1)), false);
    assert.equal(queue.enqueue(item("u5", 5)), true);
  });

  it("drops the interrupted turn but keeps newer speech", () => {
    const queue = new PlaybackQueue();
    queue.enqueue(item("u1", 1));
    queue.enqueue(item("u2", 2));
    queue.enqueue(item("u3", 3));
    queue.markPlayed(item("u1", 1));

    // Interruption at sequence 2: the active/queued turn 2 is discarded,
    // while turn 3 (already new speech) survives.
    const dropped = queue.interrupt(2);
    assert.equal(dropped, 1);
    assert.equal(queue.size, 1);
    assert.equal(queue.next()?.utteranceId, "u3");
    assert.equal(queue.playedUpTo, 2);
  });

  it("rejects a late frame for the interrupted turn", () => {
    const queue = new PlaybackQueue();
    queue.markPlayed(item("u1", 1));
    queue.enqueue(item("u2", 2));
    queue.interrupt(2);
    // A tardy TTS response or audio blob for the old turn stays dead…
    assert.equal(queue.enqueue(item("u2", 2)), false);
    assert.equal(queue.enqueue(item("u1", 1)), false);
    // …while a genuinely new utterance plays normally.
    assert.equal(queue.enqueue(item("u3", 3)), true);
  });

  it("keeps the newest boundary when interruptions arrive rapidly", () => {
    const queue = new PlaybackQueue();
    queue.enqueue(item("u1", 1));
    queue.interrupt(1);
    queue.enqueue(item("u2", 2));
    queue.interrupt(2);
    assert.equal(queue.playedUpTo, 2);
    // A boundary at or below the watermark is a no-op (nothing to re-cut).
    assert.equal(queue.interrupt(2), 0);
    assert.equal(queue.enqueue(item("u2", 2)), false);
    assert.equal(queue.enqueue(item("u3", 3)), true);
  });

  it("forgets everything on reset so a new room's first sequence plays", () => {
    const queue = new PlaybackQueue();
    queue.markPlayed(item("u1", 5));
    queue.enqueue(item("u2", 6));
    queue.reset();
    assert.equal(queue.size, 0);
    assert.equal(queue.playedUpTo, 0);
    // The same ids and low sequences are acceptable again after a reset.
    assert.equal(queue.enqueue(item("u1", 1)), true);
    assert.equal(queue.enqueue(item("u2", 2)), true);
  });

  it("bounds its memory and marks overflow played so it cannot return", () => {
    const queue = new PlaybackQueue({ capacity: 2 });
    assert.equal(queue.enqueue(item("u1", 1)), true);
    assert.equal(queue.enqueue(item("u2", 2)), true);
    // u1 falls off (the conversation moved on without playing it).
    assert.equal(queue.enqueue(item("u3", 3)), true);
    assert.equal(queue.size, 2);
    assert.equal(queue.enqueue(item("u1", 1)), false);
    const inQueue = queue.next()?.utteranceId;
    assert.ok(inQueue === "u2" || inQueue === "u3");
  });
});
