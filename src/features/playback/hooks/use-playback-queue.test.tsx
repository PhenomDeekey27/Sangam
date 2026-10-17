import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mountHook } from "@/test/react-harness";
import type { PlaybackPlayer } from "@/features/playback/hooks/use-playback-queue";
import { usePlaybackQueue } from "@/features/playback/hooks/use-playback-queue";
import {
  createScriptedPlayer,
  payload,
} from "@/features/playback/hooks/playback-test-helpers";

describe("usePlaybackQueue", () => {
  it("plays a delivery in order and reports its states", async () => {
    const script = createScriptedPlayer();
    const harness = await mountHook(
      (props: { createPlayer: () => PlaybackPlayer }) =>
        usePlaybackQueue({ createPlayer: props.createPlayer }),
      { props: { createPlayer: () => script.player } },
    );
    try {
      assert.deepEqual(harness.current().state, { status: "idle" });

      harness.current().enqueue(payload("u1", 1), new ArrayBuffer(4));
      await harness.advance(0);
      assert.deepEqual(harness.current().state, { status: "playing" });
      assert.deepEqual(script.played, ["u1"]);

      await harness.perform(() => script.resume());
      await harness.advance(0);
      assert.deepEqual(harness.current().state, { status: "idle" });
    } finally {
      await harness.unmount();
    }
  });

  it("queues two deliveries in sequence order and never replays one", async () => {
    const script = createScriptedPlayer();
    const harness = await mountHook(
      (props: { createPlayer: () => PlaybackPlayer }) =>
        usePlaybackQueue({ createPlayer: props.createPlayer }),
      { props: { createPlayer: () => script.player } },
    );
    try {
      // Out-of-order arrival still plays 1 first.
      harness.current().enqueue(payload("u2", 2), new ArrayBuffer(4));
      harness.current().enqueue(payload("u1", 1), new ArrayBuffer(4));
      await harness.advance(0);
      assert.deepEqual(script.played, ["u1"]);

      script.resume();
      await harness.advance(0);
      assert.deepEqual(script.played, ["u1", "u2"]);

      // A duplicate id, even after playback, is discarded.
      await harness.perform(() => script.resume());
      harness.current().enqueue(payload("u1", 1), new ArrayBuffer(4));
      await harness.advance(0);
      assert.deepEqual(script.played, ["u1", "u2"]);
    } finally {
      await harness.unmount();
    }
  });

  it("manual stop drains the queue and reports stopped", async () => {
    const script = createScriptedPlayer();
    const harness = await mountHook(
      (props: { createPlayer: () => PlaybackPlayer }) =>
        usePlaybackQueue({ createPlayer: props.createPlayer }),
      { props: { createPlayer: () => script.player } },
    );
    try {
      const { enqueue, stop } = harness.current();
      enqueue(payload("u1", 1), new ArrayBuffer(4));
      await harness.advance(0);
      await harness.perform(() => {
        stop();
        script.resume("stopped");
      });
      await harness.advance(0);
      assert.deepEqual(harness.current().state, { status: "stopped" });

      // A late-arriving older item is stale; a fresh one plays again.
      enqueue(payload("u0", 0), new ArrayBuffer(4));
      await harness.advance(0);
      assert.deepEqual(script.played, ["u1"]);

      enqueue(payload("u5", 5), new ArrayBuffer(4));
      await harness.advance(0);
      assert.deepEqual(script.played, ["u1", "u5"]);
      await harness.perform(() => script.resume());
      await harness.advance(0);
      assert.deepEqual(harness.current().state, { status: "idle" });
    } finally {
      await harness.unmount();
    }
  });

  it("parks on autoplay refusal and resumes after a gesture", async () => {
    const script = createScriptedPlayer();
    script.setNextOutcome("blocked");
    const harness = await mountHook(
      (props: { createPlayer: () => PlaybackPlayer }) =>
        usePlaybackQueue({ createPlayer: props.createPlayer }),
      { props: { createPlayer: () => script.player } },
    );
    try {
      const { enqueue } = harness.current();
      enqueue(payload("u1", 1), new ArrayBuffer(4));
      await harness.advance(0);
      assert.deepEqual(script.blocked, ["u1"]);
      assert.deepEqual(harness.current().state, { status: "blocked" });

      // The item stays parked (not played, not dropped).
      assert.deepEqual(script.played, ["u1"]);

      await harness.perform(() => {
        document.dispatchEvent(new window.Event("pointerdown"));
      });
      await harness.advance(0);
      await harness.perform(() => script.resume());
      await harness.advance(0);
      assert.deepEqual(harness.current().state, { status: "idle" });
    } finally {
      await harness.unmount();
    }
  });

  it("stops active audio and discards the interrupted turn", async () => {
    const script = createScriptedPlayer();
    const harness = await mountHook(
      (props: { createPlayer: () => PlaybackPlayer }) =>
        usePlaybackQueue({ createPlayer: props.createPlayer }),
      { props: { createPlayer: () => script.player } },
    );
    try {
      const { enqueue, interrupt } = harness.current();
      enqueue(payload("u1", 1), new ArrayBuffer(4));
      enqueue(payload("u2", 2), new ArrayBuffer(4));
      await harness.advance(0);
      assert.deepEqual(script.played, ["u1"]);

      // Boundary 2: the active turn and the queued turn 2 both belong to it.
      await harness.perform(() => interrupt(2));
      await harness.advance(0);

      assert.deepEqual(script.played, ["u1"]);
      assert.deepEqual(harness.current().state, { status: "idle" });
    } finally {
      await harness.unmount();
    }
  });

  it("plays new speech after an interruption and rejects late old audio", async () => {
    const script = createScriptedPlayer();
    const harness = await mountHook(
      (props: { createPlayer: () => PlaybackPlayer }) =>
        usePlaybackQueue({ createPlayer: props.createPlayer }),
      { props: { createPlayer: () => script.player } },
    );
    try {
      const { enqueue, interrupt } = harness.current();
      enqueue(payload("u1", 1), new ArrayBuffer(4));
      enqueue(payload("u2", 2), new ArrayBuffer(4));
      enqueue(payload("u3", 3), new ArrayBuffer(4));
      await harness.advance(0);
      assert.deepEqual(script.played, ["u1"]);

      // Interrupt up to 2: u2 is dropped, but u3 (new speech) still plays.
      await harness.perform(() => interrupt(2));
      await harness.advance(0);
      assert.deepEqual(script.played, ["u1", "u3"]);

      // A late frame for the interrupted turn can never restart playback.
      enqueue(payload("u2", 2), new ArrayBuffer(4));
      await harness.advance(0);
      assert.deepEqual(script.played, ["u1", "u3"]);

      // The next genuine utterance plays normally.
      await harness.perform(() => script.resume());
      await harness.advance(0);
      enqueue(payload("u4", 4), new ArrayBuffer(4));
      await harness.advance(0);
      assert.deepEqual(script.played, ["u1", "u3", "u4"]);
      await harness.perform(() => script.resume());
      await harness.advance(0);
      assert.deepEqual(harness.current().state, { status: "idle" });
    } finally {
      await harness.unmount();
    }
  });

  it("applies rapid interruptions once and stays consistent", async () => {
    const script = createScriptedPlayer();
    const harness = await mountHook(
      (props: { createPlayer: () => PlaybackPlayer }) =>
        usePlaybackQueue({ createPlayer: props.createPlayer }),
      { props: { createPlayer: () => script.player } },
    );
    try {
      const { enqueue, interrupt } = harness.current();
      enqueue(payload("u1", 1), new ArrayBuffer(4));
      await harness.advance(0);
      assert.deepEqual(script.played, ["u1"]);

      // Two interruptions in one tick: the newest boundary wins, the stop is
      // applied once, and nothing throws.
      await harness.perform(() => {
        interrupt(1);
        interrupt(2);
      });
      await harness.advance(0);
      assert.deepEqual(script.played, ["u1"]);
      assert.deepEqual(harness.current().state, { status: "idle" });

      enqueue(payload("u1", 1), new ArrayBuffer(4));
      enqueue(payload("u2", 2), new ArrayBuffer(4));
      await harness.advance(0);
      assert.deepEqual(script.played, ["u1"]);

      enqueue(payload("u3", 3), new ArrayBuffer(4));
      await harness.advance(0);
      assert.deepEqual(script.played, ["u1", "u3"]);
      await harness.perform(() => script.resume());
      await harness.advance(0);
      assert.deepEqual(harness.current().state, { status: "idle" });
    } finally {
      await harness.unmount();
    }
  });

  it("reset stops active audio and forgets the room's watermark", async () => {
    const script = createScriptedPlayer();
    const harness = await mountHook(
      (props: { createPlayer: () => PlaybackPlayer }) =>
        usePlaybackQueue({ createPlayer: props.createPlayer }),
      { props: { createPlayer: () => script.player } },
    );
    try {
      const { enqueue, reset } = harness.current();
      enqueue(payload("u5", 5), new ArrayBuffer(4));
      await harness.advance(0);
      assert.deepEqual(script.played, ["u5"]);

      await harness.perform(() => reset());
      await harness.advance(0);
      assert.deepEqual(harness.current().state, { status: "idle" });

      // A brand-new room starts at sequence 1: no stale watermark blocks it.
      enqueue(payload("v1", 1), new ArrayBuffer(4));
      await harness.advance(0);
      assert.deepEqual(script.played, ["u5", "v1"]);
      await harness.perform(() => script.resume());
      await harness.advance(0);
      assert.deepEqual(harness.current().state, { status: "idle" });
    } finally {
      await harness.unmount();
    }
  });

  it("a broken item is skipped without losing later ones", async () => {
    const script = createScriptedPlayer();
    const notices: Array<string | null> = [];
    const harness = await mountHook(
      (props: { createPlayer: () => PlaybackPlayer; onNotice: (m: string | null) => void }) =>
        usePlaybackQueue({
          createPlayer: props.createPlayer,
          onNotice: props.onNotice,
        }),
      {
        props: {
          createPlayer: () => script.player,
          onNotice: (message) => {
            notices.push(message);
          },
        },
      },
    );
    try {
      const { enqueue } = harness.current();
      enqueue(payload("u1", 1), new ArrayBuffer(4));
      enqueue(payload("u2", 2), new ArrayBuffer(4));
      await harness.advance(0);
      assert.deepEqual(script.played, ["u1"]);

      // Corrupt audio: the first play rejects and is consumed as an error.
      await harness.perform(() => script.failPending());
      await harness.advance(0);
      // The failure is reported through the notice channel while playback
      // continues with u2, whose translated text stays on screen either way.
      assert.ok(
        notices.some(
          (message) =>
            message !== null && message.includes("translation aloud"),
        ),
        `expected a playback-failure notice, got ${JSON.stringify(notices)}`,
      );
      assert.deepEqual(script.played, ["u1", "u2"]);
      assert.deepEqual(harness.current().state, { status: "playing" });
      await harness.perform(() => script.resume());
      await harness.advance(0);
      assert.deepEqual(harness.current().state, { status: "idle" });
    } finally {
      await harness.unmount();
    }
  });

  it("reports the moment audio actually starts, and never a blocked attempt", async () => {
    const script = createScriptedPlayer();
    const starts: Array<{ id: string; sequence: number }> = [];
    const harness = await mountHook(
      (props: {
        createPlayer: () => PlaybackPlayer;
        onPlaybackStart: (id: string, sequence: number) => void;
      }) =>
        usePlaybackQueue({
          createPlayer: props.createPlayer,
          onPlaybackStart: props.onPlaybackStart,
        }),
      {
        props: {
          createPlayer: () => script.player,
          onPlaybackStart: (id, sequence) => starts.push({ id, sequence }),
        },
      },
    );
    try {
      const { enqueue } = harness.current();
      enqueue(payload("u1", 1), new ArrayBuffer(4));
      await harness.advance(0);
      assert.deepEqual(starts, [{ id: "u1", sequence: 1 }]);

      await harness.perform(() => script.resume());
      await harness.advance(0);

      // A refused start (autoplay policy) reports no start at all.
      script.setNextOutcome("blocked");
      enqueue(payload("u2", 2), new ArrayBuffer(4));
      await harness.advance(0);
      assert.deepEqual(starts, [{ id: "u1", sequence: 1 }]);
    } finally {
      await harness.unmount();
    }
  });

  it("exposes the active item as nowPlaying and clears it when idle", async () => {
    const script = createScriptedPlayer();
    const harness = await mountHook(
      (props: { createPlayer: () => PlaybackPlayer }) =>
        usePlaybackQueue({ createPlayer: props.createPlayer }),
      { props: { createPlayer: () => script.player } },
    );
    try {
      assert.equal(harness.current().nowPlaying, null);

      const { enqueue, interrupt } = harness.current();
      enqueue(payload("u1", 1), new ArrayBuffer(4));
      await harness.advance(0);
      assert.deepEqual(harness.current().nowPlaying, {
        utteranceId: "u1",
        sequence: 1,
        language: "pa",
      });

      // Interrupting mutes the active turn and clears the attribution.
      await harness.perform(() => interrupt(1));
      await harness.advance(0);
      assert.equal(harness.current().nowPlaying, null);
    } finally {
      await harness.unmount();
    }
  });
});
