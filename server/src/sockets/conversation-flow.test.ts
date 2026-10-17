/**
 * Wire-level behavior for interrupt delivery and overlapping speech: this is
 * where duplicate/stale interruption events and simultaneous finals meet the
 * relay. Kept apart from the lifecycle suite only for file length.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import {
  io as connectClient,
  type Socket as ClientSocket,
} from "socket.io-client";
import { createSangamServer, type SangamServer } from "../app.js";
import {
  INTERRUPT_COOLDOWN_MS,
  createInterruptGate,
} from "./room-handlers.js";
import type {
  ClientToServerEvents,
  RoomOpAck,
  ServerToClientEvents,
} from "./contract.js";

type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

let server: SangamServer;
let url: string;

before(async () => {
  server = createSangamServer({
    port: 0,
    clientOrigins: ["http://localhost:3000"],
    isProduction: false,
  });
  await server.listen();
  const address = server.httpServer.address() as AddressInfo;
  url = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await server.close();
});

function connect(): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = connectClient(url, {
      transports: ["websocket"],
      reconnection: false,
    });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });
}

function callAck(
  socket: TestClient,
  event: "room:create" | "room:join",
  payload: { code: string; language: string },
): Promise<RoomOpAck> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (response: RoomOpAck) => resolve(response));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceEvent<E extends keyof ServerToClientEvents>(
  socket: TestClient,
  event: E,
  timeoutMs = 2000,
): Promise<Parameters<ServerToClientEvents[E]>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener as never);
      reject(new Error(`timed out waiting for ${String(event)}`));
    }, timeoutMs);
    const listener = (...args: Parameters<ServerToClientEvents[E]>) => {
      clearTimeout(timer);
      resolve(args);
    };
    socket.once(event, listener as never);
  });
}

interface RoomPair {
  readonly creator: TestClient;
  readonly joiner: TestClient;
}

async function pair(code: string): Promise<RoomPair> {
  const creator = await connect();
  const joiner = await connect();
  const created = await callAck(creator, "room:create", {
    code,
    language: "en",
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const joined = await callAck(joiner, "room:join", { code, language: "ta" });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  return { creator, joiner };
}

interface UtteranceEntry {
  readonly utterance: { readonly speakerSide: string; readonly sequence: number };
}

describe("createInterruptGate", () => {
  it("allows the first call and blocks repeats inside the window", () => {
    let time = 0;
    const gate = createInterruptGate(INTERRUPT_COOLDOWN_MS, () => time);
    assert.equal(gate(), true);
    time = 100;
    assert.equal(gate(), false);
    time = INTERRUPT_COOLDOWN_MS - 1;
    assert.equal(gate(), false);
  });

  it("opens again once the cooldown has fully elapsed", () => {
    let time = 0;
    const gate = createInterruptGate(INTERRUPT_COOLDOWN_MS, () => time);
    assert.equal(gate(), true);
    time = INTERRUPT_COOLDOWN_MS;
    assert.equal(gate(), true);
    time = INTERRUPT_COOLDOWN_MS + 10;
    assert.equal(gate(), false);
  });

  it("accepts zero-length cooldowns as open every call", () => {
    let time = 0;
    const gate = createInterruptGate(0, () => time);
    assert.equal(gate(), true);
    time = 5;
    assert.equal(gate(), true);
  });
});

describe("interrupt and overlapping-speech relays", () => {
  it("suppresses duplicate interrupts from one socket until the cooldown passes", async () => {
    const { creator, joiner } = await pair("PASSDU");
    const received: unknown[] = [];
    creator.on("conversation:interrupt", (payload) => received.push(payload));

    // Two emits in rapid succession: only the first may pass the gate.
    joiner.emit("conversation:interrupt");
    joiner.emit("conversation:interrupt");
    await delay(150);
    assert.equal(received.length, 1);

    // Once the window has fully elapsed, a deliberate re-interruption fires.
    await delay(INTERRUPT_COOLDOWN_MS + 100);
    joiner.emit("conversation:interrupt");
    await delay(150);
    assert.equal(received.length, 2);

    creator.disconnect();
    joiner.disconnect();
  });

  it("delivers concurrent finals from both seats to both participants", async () => {
    const { creator, joiner } = await pair("RSTUVW");
    const creatorEntries: UtteranceEntry[] = [];
    const joinerEntries: UtteranceEntry[] = [];
    const errs: string[] = [];
    creator.on("conversation:utterance", (payload) =>
      creatorEntries.push(payload.entry as UtteranceEntry),
    );
    joiner.on("conversation:utterance", (payload) =>
      joinerEntries.push(payload.entry as UtteranceEntry),
    );
    creator.on("error", (e) => errs.push(e.code));
    joiner.on("error", (e) => errs.push(e.code));

    await Promise.all([
      creator.emit("conversation:utterance", {
        utteranceId: "utt-creator-1",
        text: "hello from a",
        language: "en",
      }),
      joiner.emit("conversation:utterance", {
        utteranceId: "utt-joiner-1",
        text: "வணக்கம் b இருந்து",
        language: "ta",
      }),
    ]);
    await delay(250);

    assert.deepEqual(errs, []);
    // Relayed to everyone on the channel, including the original speakers.
    assert.equal(creatorEntries.length, 2);
    assert.equal(joinerEntries.length, 2);
    const sides = (entries: UtteranceEntry[]) =>
      entries
        .map((entry) => entry.utterance.speakerSide)
        .sort()
        .join(",");
    assert.equal(sides(creatorEntries), "a,b");
    assert.equal(sides(joinerEntries), "a,b");

    // The server sequences overlapping finals, so both seats agree on order.
    assert.equal(creatorEntries[0]?.utterance.sequence,
      joinerEntries[0]?.utterance.sequence);

    creator.disconnect();
    joiner.disconnect();
  });

  it("stamps the interruption boundary with the last relayed utterance", async () => {
    const { creator, joiner } = await pair("BNDARY");
    const stored = new Promise<UtteranceEntry>((resolve) =>
      creator.once("conversation:utterance", (payload) =>
        resolve(payload.entry as UtteranceEntry),
      ),
    );
    creator.emit("conversation:utterance", {
      utteranceId: "utt-boundary-1",
      text: "hello there",
      language: "en",
    });
    const { utterance } = await stored;
    assert.equal(utterance.sequence, 1);

    // The partner's interrupt carries the turn boundary the server itself
    // assigned, never a client claim.
    const boundary = new Promise<{ side: string; sequence: number }>((resolve) =>
      joiner.once("conversation:interrupt", (payload) => resolve(payload)),
    );
    creator.emit("conversation:interrupt");
    const interrupt = await boundary;
    assert.equal(interrupt.side, "a");
    assert.equal(interrupt.sequence, utterance.sequence);

    creator.disconnect();
    joiner.disconnect();
  });

  it("keeps transcript history intact across an interruption", async () => {
    const { creator, joiner } = await pair("KEEPTS");
    const stored = new Promise<UtteranceEntry>((resolve) =>
      creator.once("conversation:utterance", (payload) =>
        resolve(payload.entry as UtteranceEntry),
      ),
    );
    creator.emit("conversation:utterance", {
      utteranceId: "utt-keep-1",
      text: "keep this line",
      language: "en",
    });
    await stored;

    const interruptSeen = new Promise<void>((resolve) =>
      joiner.once("conversation:interrupt", () => resolve()),
    );
    creator.emit("conversation:interrupt");
    await interruptSeen;

    // A rejoining seat still receives the original row: an interruption
    // changes nothing about the retained transcript.
    joiner.disconnect();
    await delay(50);
    const rejoiner = await connect();
    const history = onceEvent(rejoiner, "conversation:history");
    await callAck(rejoiner, "room:join", { code: "KEEPTS", language: "ta" });
    const [{ entries }] = await history;
    assert.ok(entries.some((row) => row.utterance.id === "utt-keep-1"));

    creator.disconnect();
    rejoiner.disconnect();
  });
});
