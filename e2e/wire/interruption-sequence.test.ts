/**
 * Deterministic, browser-free interruption proof (supporting evidence).
 *
 * This boots the *real* Sangam Socket.IO server in-process with the mock
 * speech provider and the scripted/controllable doubles, drives two real
 * Socket.IO clients through a long turn, an in-flight turn, and a real
 * `conversation:interrupt`, then feeds every delivery into the *real*
 * front-end `PlaybackQueue`. It therefore pins the server's boundary stamping,
 * stale-frame discard, deduplication, and post-interruption recovery without a
 * browser or a vendor call.
 *
 * Run with: npm run test:e2e:wire
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { io, type Socket } from "socket.io-client";
import { PlaybackQueue } from "../../src/features/playback/services/playback-queue.js";

const ROOM = "TRVXYZ";

interface WireMessage {
  readonly event: string;
  readonly args: unknown[];
}

/** Collects every event one socket receives so waits can filter by payload. */
class Inbox {
  readonly messages: WireMessage[] = [];
  private readonly waiters: Array<{
    event: string;
    match: (message: WireMessage) => boolean;
    ok: (message: WireMessage) => void;
    fail: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(socket: Socket) {
    socket.onAny((event: string, ...args: unknown[]) => {
      const message: WireMessage = { event, args };
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (waiter.event !== event || !waiter.match(message)) continue;
        clearTimeout(waiter.timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.ok(message);
      }
    });
  }

  waitFor(
    event: string,
    match: (message: WireMessage) => boolean = () => true,
    timeoutMs = 10_000,
  ): Promise<WireMessage> {
    const existing = this.messages.find(
      (message) => message.event === event && match(message),
    );
    if (existing) return Promise.resolve(existing);
    return new Promise((ok, fail) => {
      const waiter = {
        event,
        match,
        ok,
        fail,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          fail(new Error(`timed out waiting for ${event}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }
}

function playbackPayload(message: WireMessage): {
  utteranceId: string;
  sequence: number;
  language: string;
  mimeType: string;
} {
  const payload = message.args[0] as {
    utteranceId?: string;
    sequence?: number;
    language?: string;
    mimeType?: string;
  };
  return {
    utteranceId: payload.utteranceId ?? "",
    sequence: payload.sequence ?? 0,
    language: payload.language ?? "",
    mimeType: payload.mimeType ?? "",
  };
}

function toArrayBuffer(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    const view = value as Uint8Array;
    return view.buffer.slice(
      view.byteOffset,
      view.byteOffset + view.byteLength,
    ) as ArrayBuffer;
  }
  return new ArrayBuffer(0);
}

function toItem(message: WireMessage) {
  const payload = playbackPayload(message);
  return {
    utteranceId: payload.utteranceId,
    sequence: payload.sequence,
    language: payload.language,
    mimeType: payload.mimeType,
    audio: toArrayBuffer(message.args[1]),
  };
}

function emitWithAck<T>(
  socket: Socket,
  event: string,
  payload: unknown,
): Promise<T> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (response: T) => resolve(response));
  });
}

function whenConnected(socket: Socket): Promise<void> {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve) => socket.once("connect", () => resolve()));
}

async function poll(
  ready: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** The pieces of the server and doubles this test drives. */
interface Harness {
  close(): Promise<void>;
  readonly tts: {
    configure(next: { mode?: string; durationMs?: number }): void;
    release(): number;
    readonly pending: number;
  };
}

let harness: Harness;
let baseUrl = "";

before(async () => {
  const { createSangamServer } = await import("../../server/src/app.js");
  const { ControllableTtsProvider, ScriptedTranslator } =
    await import("../server/providers.js");
  const translator = new ScriptedTranslator();
  const tts = new ControllableTtsProvider();
  const server = createSangamServer(
    {
      port: 0,
      clientOrigins: ["http://localhost"],
      isProduction: false,
      speech: { provider: "mock" },
      translation: { provider: "none" },
      tts: { provider: "none" },
    },
    { translator, ttsProvider: tts },
  );
  await server.listen();
  const address = server.httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  harness = { tts, close: () => server.close() };
});

after(async () => {
  await harness.close();
});

test("an interruption stops the active turn, discards the stale one, and lets new speech play", async () => {
  const a = io(baseUrl, { transports: ["websocket"] });
  const b = io(baseUrl, { transports: ["websocket"] });
  const inboxA = new Inbox(a);
  const inboxB = new Inbox(b);
  try {
    await Promise.all([whenConnected(a), whenConnected(b)]);

    const created = await emitWithAck<{ ok: boolean; self?: { side: string } }>(
      a,
      "room:create",
      { code: ROOM, language: "en", listeningLanguage: "ta" },
    );
    assert.equal(created.ok, true);
    assert.equal(created.self?.side, "a");

    const joined = await emitWithAck<{ ok: boolean; self?: { side: string } }>(
      b,
      "room:join",
      { code: ROOM, language: "ta", listeningLanguage: "en" },
    );
    assert.equal(joined.ok, true);
    assert.equal(joined.self?.side, "b");

    // A long first turn plays while the second turn's synthesis is held.
    harness.tts.configure({ mode: "immediate", durationMs: 6000 });
    a.emit("conversation:utterance", {
      utteranceId: "wire-utt-1",
      text: "one",
      language: "en",
    });
    const first = await inboxB.waitFor(
      "conversation:playback",
      (message) => playbackPayload(message).sequence === 1,
    );

    const queue = new PlaybackQueue();
    assert.equal(queue.enqueue(toItem(first)), true);
    assert.equal(queue.next()?.utteranceId, "wire-utt-1");

    harness.tts.configure({ mode: "deferred" });
    a.emit("conversation:utterance", {
      utteranceId: "wire-utt-2",
      text: "two",
      language: "en",
    });
    await inboxB.waitFor("conversation:translation", (message) => {
      const data = message.args[0] as { utteranceId?: string };
      return data.utteranceId === "wire-utt-2";
    });
    await poll(
      () => harness.tts.pending === 1,
      "the second synthesis to be held",
    );

    // The real interruption round trip: ack must report it was relayed.
    const ack = await emitWithAck<{
      ok: boolean;
      relayed: boolean;
      interruptId: string;
    }>(a, "conversation:interrupt", { interruptId: "wire-interrupt-1" });
    assert.equal(ack.ok, true);
    assert.equal(ack.relayed, true);

    const interrupt = await inboxB.waitFor(
      "conversation:interrupt",
      (message) => (message.args[0] as { sequence?: number }).sequence === 2,
    );
    const boundary = interrupt.args[0] as { sequence: number; side: string };
    assert.equal(boundary.side, "a");

    // The listener stops the active turn and advances its boundary.
    queue.interrupt(boundary.sequence);
    assert.equal(queue.playedUpTo, 2);
    assert.equal(queue.next(), null);

    // The released stale delivery can never be enqueued again.
    assert.equal(harness.tts.release(), 1);
    const stale = await inboxB.waitFor(
      "conversation:playback",
      (message) => playbackPayload(message).sequence === 2,
    );
    assert.equal(queue.enqueue(toItem(stale)), false);
    assert.equal(
      inboxA.messages.filter((m) => m.event === "conversation:playback").length,
      0,
    );

    // Recovery: the next turn plays, and a duplicate is refused.
    harness.tts.configure({ mode: "immediate", durationMs: 2000 });
    a.emit("conversation:utterance", {
      utteranceId: "wire-utt-3",
      text: "three",
      language: "en",
    });
    const third = await inboxB.waitFor(
      "conversation:playback",
      (message) => playbackPayload(message).sequence === 3,
    );
    assert.equal(queue.enqueue(toItem(third)), true);
    assert.equal(queue.next()?.utteranceId, "wire-utt-3");
    assert.equal(queue.enqueue(toItem(third)), false);

    // Exactly one delivery for the interrupted turn ever arrived.
    assert.equal(
      inboxB.messages.filter(
        (message) =>
          message.event === "conversation:playback" &&
          playbackPayload(message).sequence === 2,
      ).length,
      1,
    );
  } finally {
    a.close();
    b.close();
  }
});
