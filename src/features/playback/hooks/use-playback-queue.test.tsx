import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mountHook } from "@/test/react-harness";
import type { PlaybackPlayer } from "@/features/playback/hooks/use-playback-queue";
import { usePlaybackQueue } from "@/features/playback/hooks/use-playback-queue";
import type { PlayOutcome } from "@/features/playback/services/audio-player";
import type { PlaybackItem } from "@/features/playback/services/playback-queue";
import type { PlaybackPayload } from "@/types/socket";

/** A scripted player: play() awaits `resume()` before it resolves. */
function createScriptedPlayer() {
  const played: string[] = [];
  const blocked: string[] = [];
  const waiters: Array<(outcome: PlayOutcome | "reject") => void> = [];
  let nextOutcome: PlayOutcome = "played";
  const release = (outcome: PlayOutcome | "reject") => {
    for (const waiter of waiters.splice(0)) waiter(outcome);
  };
  const player: PlaybackPlayer = {
    play(item: PlaybackItem) {
      played.push(item.utteranceId);
      if (nextOutcome === "blocked") {
        // Autoplay refusal is known synchronously: the browser refuses to
        // start audio, so the hook learns "blocked" without any waiter.
        blocked.push(item.utteranceId);
        nextOutcome = "played";
        return Promise.resolve<PlayOutcome>("blocked");
      }
      return new Promise<PlayOutcome>((resolve, reject) => {
        waiters.push((outcome) => {
          if (outcome === "reject") {
            reject(new Error("audio element error"));
            return;
          }
          resolve(outcome);
        });
      });
    },
    stop() {
      release("stopped");
    },
    dispose() {
      release("stopped");
    },
  };
  return {
    player,
    played,
    blocked,
    /** Resolve every pending play with the given outcome. */
    resume(outcome: PlayOutcome = "played") {
      release(outcome);
    },
    /** Reject every pending play (corrupt audio, unsupported …). */
    failPending() {
      release("reject");
    },
    setNextOutcome(outcome: PlayOutcome) {
      nextOutcome = outcome;
    },
  };
}

function payload(
  utteranceId: string,
  sequence: number,
): PlaybackPayload {
  return { utteranceId, sequence, language: "pa", mimeType: "audio/wav" };
}

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
});
