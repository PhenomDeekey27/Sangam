/**
 * Regression: translated playback was disabled in the room UI.
 *
 * The control's enabled state came from `playback.status === "playing"`, so it
 * was greyed out in exactly the states a listener waits in — an idle empty
 * queue, an autoplay-parked queue, and a queue latched in `error` after one
 * failed item. With no enabled action there was nothing to click to unlock
 * audio, and the queue never recovered on its own.
 *
 * These tests drive the queue through the whole reported sequence: idle and
 * empty → unlock available → a delivery plays → a failed delivery stays
 * visible without latching the surface → the next delivery recovers →
 * an interruption still lets new speech play afterwards.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mountHook } from "@/test/react-harness";
import { usePlaybackQueue } from "@/features/playback/hooks/use-playback-queue";
import type { PlaybackPlayer } from "@/features/playback/hooks/playback-queue-types";
import {
  createScriptedPlayer,
  payload,
} from "@/features/playback/hooks/playback-test-helpers";
import { playbackControl } from "@/features/conversation/utils/playback-control";

describe("translated playback recovery", () => {
  it("never latches the surface off: idle → play → failure → recovery → interrupt", async () => {
    const script = createScriptedPlayer();
    const notices: Array<string | null> = [];
    const harness = await mountHook(
      (props: {
        createPlayer: () => PlaybackPlayer;
        onNotice: (message: string | null) => void;
      }) =>
        usePlaybackQueue({
          createPlayer: props.createPlayer,
          onNotice: props.onNotice,
        }),
      {
        props: {
          createPlayer: () => script.player,
          onNotice: (message) => notices.push(message),
        },
      },
    );
    try {
      // 1. A fresh, empty queue is idle, and playback is not "playing".
      assert.equal(harness.current().state.status, "idle");
      assert.equal(harness.current().nowPlaying, null);

      // 2. The control that unlocks audio is available on demand, and doing
      //    nothing with an empty queue is harmless.
      assert.equal(typeof harness.current().unlock, "function");
      await harness.perform(() => harness.current().unlock());
      await harness.advance(0);
      assert.equal(harness.current().state.status, "idle");
      assert.deepEqual(script.played, []);

      // 3. A delivered translation is played automatically.
      harness.current().enqueue(payload("u1", 1), new ArrayBuffer(8));
      await harness.advance(0);
      assert.deepEqual(script.played, ["u1"]);
      assert.equal(harness.current().state.status, "playing");
      assert.equal(harness.current().nowPlaying?.utteranceId, "u1");

      // 4. The element refuses to play: the failure is reported, not hidden.
      await harness.perform(() => script.failPending());
      await harness.advance(0);
      assert.equal(harness.current().state.status, "error");
      assert.notEqual(notices.at(-1), null);
      assert.equal(harness.current().nowPlaying, null);
      // The button behind this state is still a working, enabled control.
      assert.equal(playbackControl("error", false).action, "unlock");
      assert.equal(playbackControl("error", false).disabled, false);

      // 5. The next valid delivery retires the latched failure immediately —
      //    the stale error notice does not outlive the new turn.
      await harness.perform(() =>
        harness.current().enqueue(payload("u2", 2), new ArrayBuffer(8)),
      );
      assert.notEqual(harness.current().state.status, "error");
      assert.equal(notices.at(-1), null);
      await harness.advance(0);
      assert.deepEqual(script.played, ["u1", "u2"]);
      assert.equal(harness.current().state.status, "playing");
      await harness.perform(() => script.resume());
      await harness.advance(0);
      assert.equal(harness.current().state.status, "idle");
      assert.equal(notices.at(-1), null);

      // 6. An interruption stops the active turn and discards it, leaving the
      //    queue ready for the speaker's new words.
      harness.current().enqueue(payload("u3", 3), new ArrayBuffer(8));
      await harness.advance(0);
      assert.deepEqual(script.played, ["u1", "u2", "u3"]);
      await harness.perform(() => harness.current().interrupt(3));
      await harness.advance(0);
      assert.equal(harness.current().nowPlaying, null);

      // 7. New speech above the interruption boundary still plays.
      harness.current().enqueue(payload("u4", 4), new ArrayBuffer(8));
      await harness.advance(0);
      assert.deepEqual(script.played, ["u1", "u2", "u3", "u4"]);
      assert.equal(harness.current().nowPlaying?.utteranceId, "u4");
      await harness.perform(() => script.resume());
      await harness.advance(0);
      assert.equal(harness.current().state.status, "idle");
    } finally {
      await harness.unmount();
    }
  });

  it("resumes a parked autoplay refusal from the user's own unlock click", async () => {
    const script = createScriptedPlayer();
    script.setNextOutcome("blocked");
    const notices: Array<string | null> = [];
    const harness = await mountHook(
      (props: {
        createPlayer: () => PlaybackPlayer;
        onNotice: (message: string | null) => void;
      }) =>
        usePlaybackQueue({
          createPlayer: props.createPlayer,
          onNotice: props.onNotice,
        }),
      {
        props: {
          createPlayer: () => script.player,
          onNotice: (message) => notices.push(message),
        },
      },
    );
    try {
      harness.current().enqueue(payload("u1", 1), new ArrayBuffer(8));
      await harness.advance(0);
      // Parked, with the queue intact and an explicit reason on screen.
      assert.equal(harness.current().state.status, "blocked");
      assert.equal(harness.current().nowPlaying, null);
      assert.ok(
        notices.some((message) => message?.includes("needs one interaction")),
        `expected an unlock notice, got ${JSON.stringify(notices)}`,
      );
      // The control offers exactly the unlock action while parked.
      const control = playbackControl("blocked", false);
      assert.equal(control.action, "unlock");
      assert.equal(control.disabled, false);
      assert.match(control.label, /Enable voice playback/);

      // The click retries the same parked item rather than dropping it, and
      // retracts the unlock notice it answers.
      await harness.perform(() => harness.current().unlock());
      await harness.advance(0);
      assert.deepEqual(script.played, ["u1", "u1"]);
      assert.equal(harness.current().state.status, "playing");
      assert.equal(harness.current().nowPlaying?.utteranceId, "u1");
      assert.equal(notices.at(-1), null);
      await harness.perform(() => script.resume());
      await harness.advance(0);
      assert.equal(harness.current().state.status, "idle");
    } finally {
      await harness.unmount();
    }
  });

  it("keeps the control enabled in every playback status but an unusable room", () => {
    for (const status of [
      "idle",
      "playing",
      "stopped",
      "blocked",
      "error",
    ] as const) {
      const control = playbackControl(status, false);
      assert.equal(
        control.disabled,
        false,
        `playback status "${status}" must not disable the control`,
      );
      assert.ok(control.label.length > 0);
      assert.ok(control.description.length > 0);
    }
    // Only a room that cannot act at all disables it.
    assert.equal(playbackControl("idle", true).disabled, true);
    assert.equal(playbackControl("blocked", true).disabled, true);
    // While something is audible the control stops it; otherwise it unlocks.
    assert.equal(playbackControl("playing", false).action, "stop");
    assert.equal(playbackControl("idle", false).action, "unlock");
  });
});
