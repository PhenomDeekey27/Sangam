import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mountHook } from "@/test/react-harness";
import type { SpeakerState } from "@/features/conversation/types";
import {
  useInterruptRequester,
  type InterruptRequestHandlers,
  type InterruptRequesterOptions,
} from "@/features/room/hooks/use-interrupt-requester";
import { SPEAKING_RESET_MS } from "@/features/room/hooks/subscribe-room-socket";

/** Records every side effect the requester hook produces. */
interface Recorder {
  readonly notes: (string | null)[];
  readonly partnerStates: SpeakerState[];
  readonly scheduled: number[];
  /** Handlers captured from the last `sendRequest`, simulating the emit. */
  handlers: InterruptRequestHandlers | null;
}

function recorder(): Recorder {
  return { notes: [], partnerStates: [], scheduled: [], handlers: null };
}

/** A `sendRequest` that behaves like the real action: emit + onRequested. */
function options(rec: Recorder): InterruptRequesterOptions {
  return {
    sendRequest: (handlers) => {
      rec.handlers = handlers;
      handlers.onRequested("int-1");
    },
    notify: (message) => rec.notes.push(message),
    setPartnerState: (state) => rec.partnerStates.push(state),
    schedule: (_callback, ms) => rec.scheduled.push(ms),
  };
}

describe("useInterruptRequester", () => {
  it("arms requesting on the click and only confirms on the partner's word", async () => {
    const rec = recorder();
    const harness = await mountHook(
      (props: Recorder) => useInterruptRequester(options(props)),
      { props: rec },
    );
    try {
      assert.equal(harness.current().state.phase, "ready");
      assert.equal(harness.current().pending, false);

      await harness.perform(() => harness.current().request());
      assert.equal(harness.current().state.phase, "requesting");
      assert.equal(harness.current().pending, true);
      assert.equal(harness.current().label, "Interrupting…");
      assert.ok(rec.notes.includes("Asking your partner to pause…"));

      // A relayed ack is delivery only: still requesting, no stop claimed.
      await harness.perform(() => {
        rec.handlers?.onAck(
          { ok: true, interruptId: "int-1", relayed: true },
          "int-1",
        );
      });
      assert.equal(harness.current().state.phase, "requesting");
      assert.ok(
        !rec.notes.some(
          (note) => note !== null && note.includes("stopped the interrupted"),
        ),
      );

      // Only the partner's confirmation declares the cancellation.
      await harness.perform(() => harness.current().confirm("int-1"));
      assert.equal(harness.current().state.phase, "confirmed");
      assert.equal(harness.current().pending, false);
      assert.equal(harness.current().label, "Interrupted");
      assert.ok(
        rec.notes.some(
          (note) => note !== null && note.includes("stopped the interrupted"),
        ),
      );
      assert.deepEqual(rec.partnerStates, ["interrupted"]);
      assert.deepEqual(rec.scheduled, [SPEAKING_RESET_MS]);
    } finally {
      await harness.unmount();
    }
  });

  it("ignores a confirmation for a superseded request", async () => {
    const rec = recorder();
    const harness = await mountHook(
      (props: Recorder) => useInterruptRequester(options(props)),
      { props: rec },
    );
    try {
      await harness.perform(() => harness.current().request());
      await harness.perform(() => harness.current().confirm("some-other-id"));
      // Nothing changed: the newer request is still awaiting its confirmation.
      assert.equal(harness.current().state.phase, "requesting");
      assert.deepEqual(rec.partnerStates, []);
    } finally {
      await harness.unmount();
    }
  });

  it("turns an unrelayed ack into a retryable error", async () => {
    const rec = recorder();
    const harness = await mountHook(
      (props: Recorder) => useInterruptRequester(options(props)),
      { props: rec },
    );
    try {
      await harness.perform(() => harness.current().request());
      await harness.perform(() => {
        rec.handlers?.onAck(
          { ok: true, interruptId: "int-1", relayed: false },
          "int-1",
        );
      });
      assert.equal(harness.current().state.phase, "error");
      assert.equal(harness.current().label, "Retry interrupt");
      assert.ok(
        rec.notes.some(
          (note) => note !== null && note.includes("Nobody else is in the room"),
        ),
      );
    } finally {
      await harness.unmount();
    }
  });

  it("abandons a pending request when the transport drops", async () => {
    const rec = recorder();
    const harness = await mountHook(
      (props: Recorder) => useInterruptRequester(options(props)),
      { props: rec },
    );
    try {
      await harness.perform(() => harness.current().request());
      await harness.perform(() => harness.current().disconnect());
      assert.equal(harness.current().state.phase, "error");
      assert.ok(
        rec.notes.some(
          (note) => note !== null && note.includes("Connection lost"),
        ),
      );
    } finally {
      await harness.unmount();
    }
  });
});
