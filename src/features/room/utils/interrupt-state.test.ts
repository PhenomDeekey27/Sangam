import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INITIAL_INTERRUPT_STATE,
  interruptButtonLabel,
  interruptNotice,
  isInterruptPending,
  reduceInterrupt,
  type InterruptState,
} from "@/features/room/utils/interrupt-state";

/** Drive the reducer through a sequence of events. */
function run(
  events: Parameters<typeof reduceInterrupt>[1][],
  start: InterruptState = INITIAL_INTERRUPT_STATE,
): InterruptState {
  return events.reduce(reduceInterrupt, start);
}

describe("interrupt requester state machine", () => {
  it("starts ready with nothing pending", () => {
    assert.deepEqual(INITIAL_INTERRUPT_STATE, {
      phase: "ready",
      interruptId: null,
      reason: null,
    });
    assert.equal(isInterruptPending(INITIAL_INTERRUPT_STATE), false);
    assert.equal(interruptNotice(INITIAL_INTERRUPT_STATE), null);
  });

  it("goes requesting on the click, before any server reply", () => {
    const state = run([{ type: "request", interruptId: "i1" }]);
    assert.equal(state.phase, "requesting");
    assert.equal(isInterruptPending(state), true);
    assert.equal(interruptButtonLabel(state), "Interrupting…");
    assert.equal(interruptNotice(state), "Asking your partner to pause…");
  });

  it("does not claim a stop when the server only relayed the request", () => {
    const state = run([
      { type: "request", interruptId: "i1" },
      { type: "ack", interruptId: "i1", ok: true, relayed: true },
    ]);
    // Still waiting for the partner's confirmation: no stop is announced.
    assert.equal(state.phase, "requesting");
    assert.equal(interruptNotice(state), "Asking your partner to pause…");
  });

  it("confirms only when the partner's cancellation arrives", () => {
    const state = run([
      { type: "request", interruptId: "i1" },
      { type: "ack", interruptId: "i1", ok: true, relayed: true },
      { type: "confirmed", interruptId: "i1" },
    ]);
    assert.equal(state.phase, "confirmed");
    assert.equal(isInterruptPending(state), false);
    assert.equal(interruptButtonLabel(state), "Interrupted");
    assert.match(interruptNotice(state) ?? "", /stopped the interrupted audio/);
  });

  it("treats an unrelayed ack as a retryable error, not a stop", () => {
    const state = run([
      { type: "request", interruptId: "i1" },
      { type: "ack", interruptId: "i1", ok: true, relayed: false },
    ]);
    assert.equal(state.phase, "error");
    assert.equal(state.reason, "not_relayed");
    assert.equal(interruptButtonLabel(state), "Retry interrupt");
    assert.match(interruptNotice(state) ?? "", /Nobody else is in the room/);
  });

  it("maps a refused request to the refused error", () => {
    const state = run([
      { type: "request", interruptId: "i1" },
      { type: "ack", interruptId: "i1", ok: false, relayed: false },
    ]);
    assert.equal(state.phase, "error");
    assert.equal(state.reason, "refused");
  });

  it("recovers from a missing confirmation with a timeout error", () => {
    const state = run([
      { type: "request", interruptId: "i1" },
      { type: "ack", interruptId: "i1", ok: true, relayed: true },
      { type: "timeout", interruptId: "i1" },
    ]);
    assert.equal(state.phase, "error");
    assert.equal(state.reason, "timeout");
    assert.match(interruptNotice(state) ?? "", /did not confirm/);
  });

  it("marks a pending request disconnected when the transport drops", () => {
    const state = run([
      { type: "request", interruptId: "i1" },
      { type: "disconnected" },
    ]);
    assert.equal(state.phase, "error");
    assert.equal(state.reason, "disconnected");
  });

  it("leaves a ready state untouched on a disconnect", () => {
    const state = run([{ type: "disconnected" }]);
    assert.deepEqual(state, INITIAL_INTERRUPT_STATE);
  });

  it("ignores late replies for a superseded request id", () => {
    // A newer request replaces the older one; the older confirmation and ack
    // must never settle the newer request.
    const state = run([
      { type: "request", interruptId: "i1" },
      { type: "request", interruptId: "i2" },
      { type: "confirmed", interruptId: "i1" },
      { type: "ack", interruptId: "i1", ok: false, relayed: false },
      { type: "timeout", interruptId: "i1" },
    ]);
    assert.equal(state.phase, "requesting");
    assert.equal(state.interruptId, "i2");

    const settled = reduceInterrupt(state, {
      type: "confirmed",
      interruptId: "i2",
    });
    assert.equal(settled.phase, "confirmed");
  });

  it("resets back to ready for the next interruption", () => {
    const state = run([
      { type: "request", interruptId: "i1" },
      { type: "confirmed", interruptId: "i1" },
      { type: "reset" },
    ]);
    assert.deepEqual(state, INITIAL_INTERRUPT_STATE);
  });
});
