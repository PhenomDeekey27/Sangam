import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import {
  io as connectClient,
  type Socket as ClientSocket,
} from "socket.io-client";
import { createSangamServer, type SangamServer } from "../app.js";
import { MAX_TEXT_LENGTH } from "../rooms/room-validation.js";
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

describe("utterance identity and ordering", () => {
  it("stamps increasing per-room sequences for later utterances", async () => {
    const { creator, joiner } = await pair("TSRVQP");
    const first = onceEvent(creator, "conversation:utterance");
    joiner.emit("conversation:utterance", {
      utteranceId: "utt-seq-0000001",
      text: "one",
      language: "en",
    });
    const [{ entry: firstEntry }] = await first;

    const second = onceEvent(creator, "conversation:utterance");
    creator.emit("conversation:utterance", {
      utteranceId: "utt-seq-0000002",
      text: "two",
      language: "en",
    });
    const [{ entry: secondEntry }] = await second;

    assert.equal(firstEntry.utterance.sequence, 1);
    assert.equal(secondEntry.utterance.sequence, 2);
    assert.equal(secondEntry.utterance.speakerSide, "a");

    creator.disconnect();
    joiner.disconnect();
  });

  it("rejects a replayed utterance id without relaying it", async () => {
    const { creator, joiner } = await pair("FGHJKM");
    const first = onceEvent(creator, "conversation:utterance");
    joiner.emit("conversation:utterance", {
      utteranceId: "utt-replay-0001",
      text: "first",
      language: "en",
    });
    await first;

    const leaks: unknown[] = [];
    creator.on("conversation:utterance", (payload) => leaks.push(payload));
    const errorPromise = onceEvent(joiner, "error");
    joiner.emit("conversation:utterance", {
      utteranceId: "utt-replay-0001",
      text: "second",
      language: "en",
    });
    const [error] = await errorPromise;
    assert.equal(error.code, "invalid_payload");
    await delay(150);
    assert.deepEqual(leaks, []);

    creator.disconnect();
    joiner.disconnect();
  });

  it("rejects utterances with a missing or malformed id", async () => {
    const { creator, joiner } = await pair("MLKJHG");
    const leaks: unknown[] = [];
    creator.on("conversation:utterance", (payload) => leaks.push(payload));

    const missingError = onceEvent(joiner, "error");
    joiner.emit("conversation:utterance", {
      text: "hi",
      language: "en",
    } as never);
    assert.equal((await missingError)[0].code, "invalid_payload");

    const malformedError = onceEvent(joiner, "error");
    joiner.emit("conversation:utterance", {
      utteranceId: "bad id!",
      text: "hi",
      language: "en",
    });
    assert.equal((await malformedError)[0].code, "invalid_payload");

    await delay(150);
    assert.deepEqual(leaks, []);
    creator.disconnect();
    joiner.disconnect();
  });
});

describe("interim relay", () => {
  it("relays interim text to the partner with the sender's server side", async () => {
    const { creator, joiner } = await pair("NMLKJH");
    const creatorSees = onceEvent(creator, "conversation:interim");

    joiner.emit("conversation:interim", {
      text: "hello wor",
      language: "en",
    });

    const [payload] = await creatorSees;
    assert.equal(payload.side, "b");
    assert.equal(payload.text, "hello wor");
    assert.equal(payload.language, "en");

    creator.disconnect();
    joiner.disconnect();
  });

  it("does not echo interim back to the sender", async () => {
    const { creator, joiner } = await pair("HJKLMN");
    const echoes: unknown[] = [];
    joiner.on("conversation:interim", (payload) => echoes.push(payload));

    const creatorSees = onceEvent(creator, "conversation:interim");
    joiner.emit("conversation:interim", { text: "no echo", language: "en" });
    await creatorSees;
    await delay(150);
    assert.deepEqual(echoes, []);

    creator.disconnect();
    joiner.disconnect();
  });

  it("relays an empty interim as the clear-line signal", async () => {
    const { creator, joiner } = await pair("NM6789");
    const creatorSees = onceEvent(creator, "conversation:interim");

    joiner.emit("conversation:interim", { text: "   ", language: "en" });

    const [payload] = await creatorSees;
    assert.equal(payload.side, "b");
    assert.equal(payload.text, "");

    creator.disconnect();
    joiner.disconnect();
  });

  it("rejects interim from non-members and spoofed payloads", async () => {
    const lonely = await connect();
    const lonelyError = onceEvent(lonely, "error");
    lonely.emit("conversation:interim", { text: "hi", language: "en" });
    assert.equal((await lonelyError)[0].code, "not_in_room");
    lonely.disconnect();

    const { creator, joiner } = await pair("NJHGF6");
    const leaks: unknown[] = [];
    creator.on("conversation:interim", (payload) => leaks.push(payload));

    const spoofError = onceEvent(joiner, "error");
    joiner.emit("conversation:interim", {
      text: "spoof",
      language: "en",
      side: "a",
    } as never);
    assert.equal((await spoofError)[0].code, "invalid_payload");

    const hugeError = onceEvent(joiner, "error");
    joiner.emit("conversation:interim", {
      text: "x".repeat(MAX_TEXT_LENGTH + 1),
      language: "en",
    });
    assert.equal((await hugeError)[0].code, "invalid_payload");

    await delay(150);
    assert.deepEqual(leaks, []);

    creator.disconnect();
    joiner.disconnect();
  });
});
