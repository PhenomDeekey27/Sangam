import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AudioPlayer, type MediaElement } from "@/features/playback/services/audio-player";
import type { PlaybackItem } from "@/features/playback/services/playback-queue";

interface FakeElementState {
  readonly element: MediaElement & { readonly src: string };
  readonly failWith?: () => Error;
  readonly fireEnded: () => void;
  readonly fireError: () => void;
  readonly paused: () => boolean;
}

/** A scripted `<audio>` element: play either succeeds or rejects. */
function createFakeElement(script: {
  readonly outcome: "resolve" | "reject-not-allowed" | "reject-other";
}): FakeElementState {
  let src = "";
  let paused = true;
  let endedListener: (() => void) | null = null;
  let errorListener: (() => void) | null = null;
  const element: MediaElement = {
    get src() {
      return src;
    },
    set src(value: string) {
      src = value;
      paused = true;
    },
    async play() {
      switch (script.outcome) {
        case "reject-not-allowed":
          throw new DOMException("play() blocked", "NotAllowedError");
        case "reject-other":
          throw new DOMException("bad source", "NotSupportedError");
        case "resolve":
          paused = false;
          break;
      }
    },
    pause() {
      paused = true;
      // stop() revokes and releases; listeners should not fire afterwards.
      endedListener = null;
      errorListener = null;
    },
    addEventListener(type: "ended" | "error", listener: () => void) {
      if (type === "ended") endedListener = listener;
      else errorListener = listener;
    },
    removeEventListener(type: "ended" | "error", listener: () => void) {
      if (type === "ended" && endedListener === listener) endedListener = null;
      if (type === "error" && errorListener === listener) errorListener = null;
    },
  };
  return {
    element,
    fireEnded: () => endedListener?.(),
    fireError: () => errorListener?.(),
    paused: () => paused,
  };
}

function sampleItem(bytes = 8): PlaybackItem {
  return {
    utteranceId: "u1",
    sequence: 1,
    language: "pa",
    mimeType: "audio/wav",
    audio: new ArrayBuffer(bytes),
  };
}

/** Drain every pending microtask before firing fake element events. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("AudioPlayer", () => {
  it("plays an item to completion and revokes its object URL", async () => {
    const revoked: string[] = [];
    const fake = createFakeElement({ outcome: "resolve" });
    const player = new AudioPlayer({
      createElement: () => fake.element,
      createObjectUrl: (blob) => `blob:${blob.type}:${blob.size}`,
      revokeObjectUrl: (url) => revoked.push(url),
    });

    const pending = player.play(sampleItem());
    // Playback begins only after the ended signal.
    await tick();
    fake.fireEnded();
    const outcome = await pending;

    assert.equal(outcome, "played");
    assert.match(fake.element.src, /^blob:audio\/wav:/);
    assert.deepEqual(revoked, [fake.element.src]);
    assert.equal(fake.paused(), true);
  });

  it("resolves blocked when the browser refuses to start audio", async () => {
    const revoked: string[] = [];
    const fake = createFakeElement({ outcome: "reject-not-allowed" });
    const player = new AudioPlayer({
      createElement: () => fake.element,
      createObjectUrl: () => "blob:u",
      revokeObjectUrl: (url) => revoked.push(url),
    });

    const outcome = await player.play(sampleItem());
    assert.equal(outcome, "blocked");
    // The parked frame's URL is cleaned up either way.
    assert.deepEqual(revoked, ["blob:u"]);
    assert.equal(fake.paused(), true);
  });

  it("rejects on a genuine playback failure", async () => {
    const fake = createFakeElement({ outcome: "reject-other" });
    const player = new AudioPlayer({
      createElement: () => fake.element,
      createObjectUrl: () => "blob:u",
      revokeObjectUrl: () => {},
    });

    await assert.rejects(player.play(sampleItem()));
  });

  it("a mid-play stop resolves stopped and mutes the element", async () => {
    const revoked: string[] = [];
    const fake = createFakeElement({ outcome: "resolve" });
    const player = new AudioPlayer({
      createElement: () => fake.element,
      createObjectUrl: () => "blob:u",
      revokeObjectUrl: (url) => revoked.push(url),
    });

    const pending = player.play(sampleItem());
    await tick();
    player.stop();
    const outcome = await pending;

    assert.equal(outcome, "stopped");
    assert.equal(fake.paused(), true);
    assert.deepEqual(revoked, ["blob:u"]);
    // An ended signal after the stop is ignored.
    assert.doesNotThrow(() => fake.fireEnded());
  });

  it("dispose mutes immediately and refuses later plays", async () => {
    const fake = createFakeElement({ outcome: "resolve" });
    const player = new AudioPlayer({
      createElement: () => fake.element,
      createObjectUrl: () => "blob:u",
      revokeObjectUrl: () => {},
    });
    const pending = player.play(sampleItem());
    await tick();
    player.dispose();
    assert.equal(await pending, "stopped");
    assert.equal(fake.paused(), true);

    await assert.rejects(
      () => player.play(sampleItem()),
      /disposed/,
    );
  });

  it("an element error during playback rejects so the caller can skip it", async () => {
    const fake = createFakeElement({ outcome: "resolve" });
    const player = new AudioPlayer({
      createElement: () => fake.element,
      createObjectUrl: () => "blob:u",
      revokeObjectUrl: () => {},
    });
    const pending = player.play(sampleItem());
    await tick();
    fake.fireError();
    await assert.rejects(pending);
  });
});
