/**
 * Regression: a genuine, non-autoplay `HTMLMediaElement.play()` rejection used
 * to produce no audio *and* no visible error — the drain reported a generic
 * notice, then immediately overwrote it with `idle` and cleared it. These tests
 * drive the real `AudioPlayer` through the hook with an element that rejects, so
 * the failure must stay visible and later audio must still play.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mountHook } from "@/test/react-harness";
import { usePlaybackQueue } from "@/features/playback/hooks/use-playback-queue";
import {
  AudioPlayer,
  type MediaElement,
} from "@/features/playback/services/audio-player";
import { payload } from "@/features/playback/hooks/playback-test-helpers";

/** A scripted `<audio>` element: `play()` rejects or resolves; the test fires
 * `ended` to complete a successful play. */
function fakeElement(outcome: "reject" | "resolve"): {
  readonly element: MediaElement;
  readonly fireEnded: () => void;
} {
  let ended: (() => void) | null = null;
  const element: MediaElement = {
    src: "",
    play() {
      return outcome === "reject"
        ? Promise.reject(new DOMException("bad source", "NotSupportedError"))
        : Promise.resolve();
    },
    pause() {
      ended = null;
    },
    addEventListener(type, listener) {
      if (type === "ended") ended = listener;
    },
    removeEventListener(type, listener) {
      if (type === "ended" && ended === listener) ended = null;
    },
  };
  return { element, fireEnded: () => ended?.() };
}

describe("usePlaybackQueue failure handling", () => {
  it("surfaces a genuine play() rejection instead of silently swallowing it", async () => {
    const rejecting = fakeElement("reject");
    const resolving = fakeElement("resolve");
    const elements = [rejecting.element, resolving.element];
    let nextElement = 0;
    // A fresh player per mount: React Strict Mode disposes the first instance.
    const createPlayer = () =>
      new AudioPlayer({
        createElement: () => elements[nextElement++] ?? resolving.element,
        createObjectUrl: () => "blob:u",
        revokeObjectUrl: () => {},
      });
    const notices: Array<string | null> = [];
    const harness = await mountHook(
      (props: { onNotice: (message: string | null) => void }) =>
        usePlaybackQueue({ createPlayer, onNotice: props.onNotice }),
      {
        props: {
          onNotice: (message) => {
            notices.push(message);
          },
        },
      },
    );
    try {
      const { enqueue } = harness.current();
      enqueue(payload("u1", 1), new ArrayBuffer(8));
      await harness.advance(0);

      // The failure is visible: an `error` state and a notice that is NOT
      // immediately cleared once the drain finishes.
      assert.equal(harness.current().state.status, "error");
      assert.ok(
        notices.some(
          (message) =>
            message !== null && message.includes("translation aloud"),
        ),
        `expected a visible playback-failure notice, got ${JSON.stringify(notices)}`,
      );
      assert.notEqual(notices.at(-1), null);
      assert.equal(harness.current().nowPlaying, null);

      // A later, healthy delivery still plays — one broken item never mutes
      // the rest of the conversation.
      enqueue(payload("u2", 2), new ArrayBuffer(8));
      await harness.advance(0);
      assert.equal(harness.current().state.status, "playing");
      assert.equal(harness.current().nowPlaying?.utteranceId, "u2");

      await harness.perform(() => resolving.fireEnded());
      await harness.advance(0);
      assert.equal(harness.current().state.status, "idle");
    } finally {
      await harness.unmount();
    }
  });
});
