import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SPEAKING_RESET_MS,
  subscribeRoomSocket,
  type RoomSubscriptionContext,
} from "@/features/room/hooks/subscribe-room-socket";
import type {
  SelfIdentity,
} from "@/features/room/hooks/use-room-socket-types";
import type { RoomSocket } from "@/features/room/services/socket";
import type { SpeakerState } from "@/features/conversation/types";
import {
  latencyTracker,
  resetLatency,
} from "@/features/conversation/utils/latency";

/** What the recipient-side handlers did, recorded as an append-only log. */
interface Recording {
  readonly youStates: SpeakerState[];
  readonly partnerStates: SpeakerState[];
  readonly notes: (string | null)[];
  /** Mimics the timer queue: `clearTimers` empties it, `schedule` appends. */
  readonly pending: { callback: () => void; ms: number }[];
  clearedTimes: number;
  /** Boundaries passed to the Stage-7 playback interruption sink. */
  readonly playbackInterrupts: number[];
  /** How many times the playback reset sink fired. */
  playbackResets: number;
  /** How many Stage-6 playback deliveries reached the queue. */
  playbackEnqueues: number;
  /** Correlation ids the server confirmed as cancelled by the partner. */
  readonly confirmed: string[];
  /** How many times an interruption was abandoned by a dropped transport. */
  disconnected: number;
}

function recording(): Recording {
  return {
    youStates: [],
    partnerStates: [],
    notes: [],
    pending: [],
    clearedTimes: 0,
    playbackInterrupts: [],
    playbackResets: 0,
    playbackEnqueues: 0,
    confirmed: [],
    disconnected: 0,
  };
}

interface FakeSocket {
  readonly socket: RoomSocket;
  readonly emitted: { readonly event: string; readonly payload: unknown }[];
  readonly dispatch: (event: string, ...args: unknown[]) => void;
}

/** Sufficient stand-in for the singleton `RoomSocket`: off/on/io wiring. */
function fakeSocket(): FakeSocket {
  const handlers = new Map<string, ((payload: never) => void)[]>();
  const emitted: { readonly event: string; readonly payload: unknown }[] = [];
  const wire = {
    connected: false,
    connect: () => {},
    emit: (event: string, payload?: unknown) => {
      emitted.push({ event, payload });
    },
    on: (event: string, listener: never) => {
      handlers.set(event, [...(handlers.get(event) ?? []), listener]);
    },
    off: (event: string, listener: never) => {
      handlers.set(
        event,
        (handlers.get(event) ?? []).filter((known) => known !== listener),
      );
    },
    io: {
      on: () => {},
      off: () => {},
    },
    dispatch: (event: string, ...args: unknown[]) => {
      for (const listener of handlers.get(event) ?? []) {
        (listener as (...values: unknown[]) => void)(...args);
      }
    },
  };
  return { socket: wire as unknown as RoomSocket, emitted, dispatch: wire.dispatch };
}

/** Build a subscription context that records every interrupt reaction. */
function contextFor(
  socket: RoomSocket,
  rec: Recording,
  self: SelfIdentity | null,
): RoomSubscriptionContext {
  return {
    socket,
    code: "RSTUVW",
    mode: "join",
    enterRoom: () => {},
    applySnapshot: () => {},
    applyUtterance: () => false,
    applyHistory: () => {},
    applyTranslation: () => false,
    partnerActivity: () => {},
    schedule: (callback: () => void, ms: number) =>
      rec.pending.push({ callback, ms }),
    clearTimers: () => {
      rec.pending.length = 0;
      rec.clearedTimes += 1;
    },
    notifyRef: {
      current: (message: string | null) => rec.notes.push(message),
    },
    silenceRef: { current: () => {} },
    playbackRef: {
      current: () => {
        rec.playbackEnqueues += 1;
      },
    },
    playbackInterruptRef: {
      current: (sequence: number) => rec.playbackInterrupts.push(sequence),
    },
    playbackResetRef: {
      current: () => {
        rec.playbackResets += 1;
      },
    },
    selfRef: { current: self },
    partnerNameRef: { current: "Speaker A" },
    onInterruptConfirmed: (interruptId: string) => {
      rec.confirmed.push(interruptId);
    },
    onInterruptDisconnected: () => {
      rec.disconnected += 1;
    },
    pendingSnapshotRef: { current: null },
    wasMemberRef: { current: false },
    setSeats: () => {},
    setConnection: () => {},
    setPartnerInterim: () => {},
    setYouState: (state: SpeakerState) => rec.youStates.push(state),
    setPartnerState: (state: SpeakerState) => rec.partnerStates.push(state),
  } as unknown as RoomSubscriptionContext;
}

describe("interrupt handling on the receiving client", () => {
  it("shows the interrupted state and schedules one reset for a partner", () => {
    const rec = recording();
    const fake = fakeSocket();
    subscribeRoomSocket(contextFor(fake.socket, rec, { id: "p1", side: "b" }));

    fake.dispatch("conversation:interrupt", {
      side: "a",
      sequence: 4,
      interruptId: "int-1",
    });

    assert.deepEqual(rec.youStates, ["interrupted"]);
    assert.deepEqual(rec.partnerStates, ["speaking"]);
    assert.deepEqual(rec.notes, [
      "Speaker A interrupted — their new words will play next.",
    ]);
    // The server-stamped boundary reaches the playback layer verbatim.
    assert.deepEqual(rec.playbackInterrupts, [4]);
    assert.equal(rec.pending.length, 1);
    assert.equal(rec.pending[0]?.ms, SPEAKING_RESET_MS);
    // The receiver confirms cancellation so the requester learns the audio
    // actually stopped rather than assuming it from its own click.
    assert.deepEqual(fake.emitted, [
      {
        event: "conversation:interrupt_ack",
        payload: { interruptId: "int-1" },
      },
    ]);

    rec.pending[0]?.callback();
    assert.deepEqual(rec.youStates, ["interrupted", "idle"]);
    assert.deepEqual(rec.partnerStates, ["speaking", "idle"]);
  });

  it("degrades a missing boundary to a pure stop", () => {
    const rec = recording();
    const fake = fakeSocket();
    subscribeRoomSocket(contextFor(fake.socket, rec, { id: "p1", side: "b" }));

    // A legacy/partial frame still stops active audio, but discards nothing.
    fake.dispatch("conversation:interrupt", { side: "a", interruptId: "int-2" });

    assert.deepEqual(rec.playbackInterrupts, [0]);
  });

  it("ignores an interrupt echoed back for its own side, without touching playback", () => {
    const rec = recording();
    const fake = fakeSocket();
    subscribeRoomSocket(contextFor(fake.socket, rec, { id: "p1", side: "a" }));

    fake.dispatch("conversation:interrupt", {
      side: "a",
      sequence: 7,
      interruptId: "int-3",
    });

    assert.deepEqual(rec.youStates, []);
    assert.deepEqual(rec.partnerStates, []);
    assert.deepEqual(rec.notes, []);
    assert.deepEqual(rec.playbackInterrupts, []);
    assert.equal(rec.pending.length, 0);
    // An own-side echo must not confirm anything back to the server either.
    assert.deepEqual(fake.emitted, []);
  });

  it("re-arms a duplicate interrupt instead of stacking resets", () => {
    const rec = recording();
    const fake = fakeSocket();
    subscribeRoomSocket(contextFor(fake.socket, rec, { id: "p1", side: "b" }));

    fake.dispatch("conversation:interrupt", {
      side: "a",
      sequence: 3,
      interruptId: "int-4",
    });
    fake.dispatch("conversation:interrupt", {
      side: "a",
      sequence: 5,
      interruptId: "int-5",
    });

    // Each arrival clears the pending reset first, so exactly one reset
    // callback is armed at any moment — no double reset queue.
    assert.equal(rec.clearedTimes, 2);
    assert.equal(rec.pending.length, 1);
    assert.equal(rec.pending[0]?.ms, SPEAKING_RESET_MS);
    // Rapid interruptions are still applied in order; the newest boundary wins
    // inside the queue, so no stale audio can slip between them.
    assert.deepEqual(rec.playbackInterrupts, [3, 5]);
    assert.deepEqual(
      fake.emitted.map((item) => item.payload),
      [{ interruptId: "int-4" }, { interruptId: "int-5" }],
    );
  });

  it("stops and forgets playback when the transport drops", () => {
    const rec = recording();
    const fake = fakeSocket();
    subscribeRoomSocket(contextFor(fake.socket, rec, { id: "p1", side: "b" }));

    assert.equal(rec.playbackResets, 0);
    fake.dispatch("disconnect", {});

    // A dropped transport must not leave the previous room's audio playing.
    assert.equal(rec.playbackResets, 1);
    assert.ok(rec.notes.includes("Connection lost — reconnecting…"));
  });

  it("resets playback when the subscription is torn down", () => {
    const rec = recording();
    const fake = fakeSocket();
    const unsubscribe = subscribeRoomSocket(
      contextFor(fake.socket, rec, { id: "p1", side: "b" }),
    );
    assert.equal(rec.playbackResets, 0);
    unsubscribe();
    // Teardown covers unmount and switching rooms: the next room starts with
    // a clean queue and watermark.
    assert.equal(rec.playbackResets, 1);
  });

  it("never queues playback from a history replay", () => {
    const rec = recording();
    const fake = fakeSocket();
    subscribeRoomSocket(contextFor(fake.socket, rec, { id: "p1", side: "b" }));

    fake.dispatch("conversation:history", {
      code: "RSTUVW",
      entries: [
        {
          utterance: {
            id: "utt-history-1",
            speakerSide: "a",
            language: "fr",
            text: "Bonjour",
            finalizedAt: 1,
            sequence: 1,
          },
          translation: { status: "complete", text: "ਸਤ", targetLanguage: "pa" },
        },
      ],
    });

    // History is transcript-only: a rejoining seat must hear nothing.
    assert.equal(rec.playbackEnqueues, 0);
    assert.deepEqual(rec.playbackInterrupts, []);
    assert.equal(rec.playbackResets, 0);
  });

  it("emits room:leave on teardown only for a seated client", () => {
    const rec = recording();
    const fake = fakeSocket();
    const seated = { id: "p1", side: "b" as SelfIdentity["side"] };
    const unsubscribe = subscribeRoomSocket(contextFor(fake.socket, rec, seated));
    unsubscribe();

    // A seated client leaves the room before the singleton is destroyed; the
    // teardown (destroyRoomSocket) then removes every listener with it.
    assert.ok(fake.emitted.some((item) => item.event === "room:leave"));

    const recIdle = recording();
    const bare = fakeSocket();
    const emptyUnsubscribe = subscribeRoomSocket(
      contextFor(bare.socket, recIdle, null),
    );
    emptyUnsubscribe();
    assert.ok(!bare.emitted.some((item) => item.event === "room:leave"));
  });

  it("resets the interrupted state when the transport drops", () => {
    const rec = recording();
    const fake = fakeSocket();
    subscribeRoomSocket(contextFor(fake.socket, rec, { id: "p1", side: "b" }));

    fake.dispatch("conversation:interrupt", { side: "a" });
    assert.deepEqual(rec.youStates, ["interrupted"]);
    assert.equal(rec.pending.length, 1);

    // Reconnection staleness: the interrupted highlight never outlives the
    // connection that relayed it.
    fake.dispatch("disconnect", {});

    assert.deepEqual(rec.youStates, ["interrupted", "idle"]);
    assert.deepEqual(rec.partnerStates, ["speaking", "idle"]);
    assert.equal(rec.pending.length, 0);
    assert.ok(rec.notes.includes("Connection lost — reconnecting…"));
    // A pending requester interruption can never be confirmed after a drop.
    assert.equal(rec.disconnected, 1);
  });

  it("routes the partner's cancellation confirmation to the requester", () => {
    const rec = recording();
    const fake = fakeSocket();
    subscribeRoomSocket(contextFor(fake.socket, rec, { id: "p1", side: "a" }));

    fake.dispatch("conversation:interrupt_confirmed", {
      side: "b",
      interruptId: "int-9",
    });

    // Only the correlation id drives the requester's state machine; the
    // confirmation itself never touches the receiver's playback sinks.
    assert.deepEqual(rec.confirmed, ["int-9"]);
    assert.deepEqual(rec.playbackInterrupts, []);
  });

  it("records the pipeline latency stages for a partner utterance", () => {
    resetLatency();
    const rec = recording();
    const fake = fakeSocket();
    const context = contextFor(fake.socket, rec, { id: "p1", side: "b" });
    // The latency marks are only reached once the row is accepted.
    (
      context as unknown as { applyUtterance: () => boolean }
    ).applyUtterance = () => true;
    subscribeRoomSocket(context);

    fake.dispatch("conversation:utterance", {
      entry: {
        utterance: {
          id: "utt-lat-1",
          speakerSide: "a",
          language: "fr",
          text: "Bonjour",
          finalizedAt: 1_000,
          sequence: 3,
        },
        translation: { status: "unavailable" },
      },
    });
    fake.dispatch("conversation:translation", {
      utteranceId: "utt-lat-1",
      translation: { status: "complete", text: "ਸਤ", targetLanguage: "pa" },
    });
    fake.dispatch(
      "conversation:playback",
      { utteranceId: "utt-lat-1", sequence: 3, language: "pa", mimeType: "audio/wav" },
      new ArrayBuffer(4),
    );

    const report = latencyTracker.report("utt-lat-1");
    assert.ok(report);
    assert.equal(report.marks.final, 1_000);
    assert.equal(typeof report.marks.utterance, "number");
    assert.equal(typeof report.marks.translation, "number");
    assert.equal(typeof report.marks.audio, "number");
    resetLatency();
  });
});
