import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CaptureEvents } from "@/features/speech/services/capture-session";
import type {
  MicCapture,
  MicCaptureFactory,
} from "@/features/speech/services/mic-capture";
import { ServerCaptureSession } from "@/features/speech/services/server-capture-session";
import type { SpeechError } from "@/features/speech/types";
import type { RoomSocket } from "@/features/room/services/socket";

type Handler = (...args: unknown[]) => void;

/** Minimal stand-in for the Socket.IO client the session drives. */
class FakeSocket {
  connected = true;
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly sent: { event: string; payload: unknown }[] = [];
  private startAck: ((response: unknown) => void) | null = null;

  on(event: string, handler: Handler): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
  }

  off(event: string, handler: Handler): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, ...args: unknown[]): void {
    this.sent.push({ event, payload: args[0] });
    if (event === "speech:start") {
      this.startAck = (args.at(-1) as (response: unknown) => void) ?? null;
    }
  }

  /** Deliver a server → client event as Socket.IO would. */
  fire(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }

  ackStart(response: unknown): void {
    this.startAck?.(response);
  }

  listeners(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  events(event: string): { event: string; payload: unknown }[] {
    return this.sent.filter((entry) => entry.event === event);
  }
}

interface FakeMic {
  readonly mic: MicCapture;
  readonly state: { started: number; stopped: number; closed: number };
  readonly push: (chunk: ArrayBuffer) => void;
}

function createMic(): FakeMic {
  let onChunk: ((chunk: ArrayBuffer) => void) | null = null;
  const state = { started: 0, stopped: 0, closed: 0 };
  const mic: MicCapture = {
    mimeType: "audio/webm;codecs=opus",
    start(callback) {
      state.started += 1;
      onChunk = callback;
    },
    stop() {
      state.stopped += 1;
    },
    close() {
      state.closed += 1;
    },
  };
  return {
    mic,
    state,
    push: (chunk) => onChunk?.(chunk),
  };
}

function factory(mic: MicCapture, failure?: unknown): MicCaptureFactory {
  return {
    supported: () => true,
    async open() {
      if (failure) throw failure;
      return mic;
    },
  };
}

interface Observed {
  readonly statuses: string[];
  readonly capturing: boolean[];
  readonly permissions: string[];
  readonly errors: (SpeechError | null)[];
  readonly notices: string[];
  readonly interims: string[];
  readonly finals: string[];
}

function recorder(): { observed: Observed; events: CaptureEvents } {
  const observed: Observed = {
    statuses: [],
    capturing: [],
    permissions: [],
    errors: [],
    notices: [],
    interims: [],
    finals: [],
  };
  const events: CaptureEvents = {
    onStatus: (status) => observed.statuses.push(status),
    onCapturing: (capturing) => observed.capturing.push(capturing),
    onPermission: (permission) => observed.permissions.push(permission),
    onError: (error) => observed.errors.push(error),
    onNotice: (message) => observed.notices.push(message),
    onInterim: (text) => observed.interims.push(text),
    onEmitInterim: () => {},
    onFinal: (text) => observed.finals.push(text),
  };
  return { observed, events };
}

function build(options: {
  language?: string;
  mic: MicCapture;
  failure?: unknown;
  socket: FakeSocket;
}) {
  const { observed, events } = recorder();
  const session = new ServerCaptureSession({
    language: options.language ?? "ta",
    events,
    describeLanguage: (code) => (code === "ta" ? "Tamil" : code),
    getSocket: () => options.socket as unknown as RoomSocket,
    capture: factory(options.mic, options.failure),
  });
  return { session, observed };
}

/** Let the mic-open promise chain and React-free microtasks drain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ServerCaptureSession start", () => {
  it("opens the provider with the seat's language and streams captured audio", async () => {
    const socket = new FakeSocket();
    const { mic, state, push } = createMic();
    const { session, observed } = build({ mic, socket });

    session.start();
    await settle();

    const [start] = socket.events("speech:start");
    assert.ok(start, "speech:start is emitted");
    assert.deepEqual(start.payload, {
      language: "ta",
      mimeType: "audio/webm;codecs=opus",
    });

    socket.ackStart({ ok: true, language: "ta" });
    await settle();

    assert.equal(observed.statuses.at(-1), "listening");
    assert.deepEqual(observed.permissions, ["granted"]);
    assert.equal(state.started, 1);
    assert.match(observed.notices.at(-1) ?? "", /speak in Tamil/);

    push(new ArrayBuffer(8));
    assert.equal(socket.events("speech:audio").length, 1);
  });

  it("relays the server's interim lines to the speaker", async () => {
    const socket = new FakeSocket();
    const { mic } = createMic();
    const { session, observed } = build({ mic, socket });
    session.start();
    await settle();
    socket.ackStart({ ok: true, language: "ta" });
    await settle();

    socket.fire("speech:interim", { text: "vanak", language: "ta" });
    assert.equal(observed.interims.at(-1), "vanak");
  });

  it("refuses to start when the socket is not connected", () => {
    const socket = new FakeSocket();
    socket.connected = false;
    const { mic } = createMic();
    const { session, observed } = build({ mic, socket });

    session.start();

    assert.equal(observed.errors.at(-1)?.code, "speech_unavailable");
    assert.equal(observed.capturing.at(-1), false);
  });
});

describe("ServerCaptureSession microphone failures", () => {
  it("reports a denied microphone as a permission problem", async () => {
    const socket = new FakeSocket();
    const { mic } = createMic();
    const { session, observed } = build({
      mic,
      socket,
      failure: new DOMException("denied", "NotAllowedError"),
    });

    session.start();
    await settle();

    assert.equal(observed.errors.at(-1)?.code, "permission_denied");
    assert.equal(observed.permissions.at(-1), "denied");
    assert.equal(observed.statuses.at(-1), "error");
    assert.equal(observed.capturing.at(-1), false);
  });

  it("reports a missing device with actionable copy", async () => {
    const socket = new FakeSocket();
    const { mic } = createMic();
    const { session, observed } = build({
      mic,
      socket,
      failure: new DOMException("no device", "NotFoundError"),
    });

    session.start();
    await settle();

    assert.equal(observed.errors.at(-1)?.code, "no_microphone");
  });
});

describe("ServerCaptureSession provider failures and recovery", () => {
  it("surfaces a provider network failure and can start again", async () => {
    const socket = new FakeSocket();
    const { mic, state } = createMic();
    const { session, observed } = build({ mic, socket });
    session.start();
    await settle();
    socket.ackStart({ ok: true, language: "ta" });
    await settle();

    socket.fire("speech:error", {
      code: "provider_network",
      message: "The recognition service is unreachable.",
    });

    assert.equal(observed.errors.at(-1)?.code, "provider_network");
    assert.equal(observed.capturing.at(-1), false);
    assert.equal(observed.statuses.at(-1), "error");
    // The failed session detaches so a stale provider error cannot fire twice.
    assert.equal(socket.listeners("speech:error"), 0);

    session.start();
    await settle();
    assert.equal(socket.events("speech:start").length, 2);
    socket.ackStart({ ok: true, language: "ta" });
    await settle();

    assert.equal(state.started, 2);
    assert.equal(observed.statuses.at(-1), "listening");
  });

  it("maps a language mismatch from the server ack", async () => {
    const socket = new FakeSocket();
    const { mic } = createMic();
    const { session, observed } = build({ mic, socket });
    session.start();
    await settle();

    socket.ackStart({
      ok: false,
      error: { code: "language_mismatch", message: "This seat speaks te." },
    });

    assert.equal(observed.errors.at(-1)?.code, "language_mismatch");
    assert.equal(observed.capturing.at(-1), false);
  });
});

describe("ServerCaptureSession cleanup", () => {
  it("stop releases the device and tells the server the turn is over", async () => {
    const socket = new FakeSocket();
    const { mic, state } = createMic();
    const { session, observed } = build({ mic, socket });
    session.start();
    await settle();
    socket.ackStart({ ok: true, language: "ta" });
    await settle();

    session.stop();

    assert.ok(state.stopped >= 1);
    assert.equal(socket.events("speech:stop").length, 1);
    assert.equal(observed.capturing.at(-1), false);
    assert.equal(observed.interims.at(-1), "");
  });

  it("dispose closes the device and detaches every listener", async () => {
    const socket = new FakeSocket();
    const { mic, state } = createMic();
    const { session, observed } = build({ mic, socket });
    session.start();
    await settle();
    socket.ackStart({ ok: true, language: "ta" });
    await settle();

    session.dispose();

    assert.ok(state.closed >= 1);
    assert.equal(socket.events("speech:stop").length, 1);
    assert.equal(socket.listeners("speech:interim"), 0);
    assert.equal(socket.listeners("speech:error"), 0);

    // Late server events must not reach a disposed session.
    const before = observed.interims.length;
    socket.fire("speech:interim", { text: "too late", language: "ta" });
    assert.equal(observed.interims.length, before);
  });
});
