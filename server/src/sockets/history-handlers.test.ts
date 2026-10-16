import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import {
  io as connectClient,
  type Socket as ClientSocket,
} from "socket.io-client";
import { createSangamServer, type SangamServer } from "../app.js";
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

interface JoinPayload {
  readonly code: string;
  readonly language: string;
  readonly listeningLanguage?: string;
}

function callAck(
  socket: TestClient,
  event: "room:create" | "room:join",
  payload: JoinPayload,
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

/** Speak one finalized utterance and wait until the room has been told. */
async function speak(
  speaker: TestClient,
  watcher: TestClient,
  payload: { utteranceId: string; text: string; language: string },
): Promise<void> {
  const relayed = onceEvent(watcher, "conversation:utterance");
  speaker.emit("conversation:utterance", payload);
  await relayed;
}

describe("transcript history replay", () => {
  it("replays retained rows to a participant who rejoins", async () => {
    const creator = await connect();
    const created = await callAck(creator, "room:create", {
      code: "HST234",
      language: "hi",
      listeningLanguage: "en",
    });
    assert.equal(created.ok, true, JSON.stringify(created));

    const firstJoiner = await connect();
    await callAck(firstJoiner, "room:join", {
      code: "HST234",
      language: "ta",
      listeningLanguage: "hi",
    });
    await speak(firstJoiner, creator, {
      utteranceId: "utt-history-0001",
      text: "Vanakkam",
      language: "ta",
    });
    await speak(creator, firstJoiner, {
      utteranceId: "utt-history-0002",
      text: "Namaste",
      language: "hi",
    });

    // The partner drops out, then comes back on a brand-new socket.
    firstJoiner.disconnect();
    await delay(120);
    const returning = await connect();
    const historyPromise = onceEvent(returning, "conversation:history");
    const rejoined = await callAck(returning, "room:join", {
      code: "HST234",
      language: "ta",
      listeningLanguage: "hi",
    });
    assert.equal(rejoined.ok, true, JSON.stringify(rejoined));

    const [history] = await historyPromise;
    assert.equal(history.code, "HST234");
    assert.deepEqual(
      history.entries.map((row) => [
        row.utterance.id,
        row.utterance.speakerSide,
        row.utterance.sequence,
        row.utterance.text,
        row.utterance.language,
        row.translation.status,
      ]),
      [
        ["utt-history-0001", "b", 1, "Vanakkam", "ta", "unavailable"],
        ["utt-history-0002", "a", 2, "Namaste", "hi", "unavailable"],
      ],
    );

    creator.disconnect();
    returning.disconnect();
  });

  it("delivers history before the join ack and before later live rows", async () => {
    const creator = await connect();
    await callAck(creator, "room:create", { code: "HST235", language: "en" });
    const speaker = await connect();
    await callAck(speaker, "room:join", { code: "HST235", language: "en" });
    await speak(speaker, creator, {
      utteranceId: "utt-order-0001",
      text: "first",
      language: "en",
    });

    // The partner's socket goes away; the returning client takes the seat.
    speaker.disconnect();
    await delay(120);

    const returning = await connect();
    const order: string[] = [];
    returning.on("conversation:history", () => order.push("history"));
    returning.on("conversation:utterance", () => order.push("live"));

    const ack = await callAck(returning, "room:join", {
      code: "HST235",
      language: "en",
    });
    order.push("ack");
    assert.equal(ack.ok, true, JSON.stringify(ack));
    assert.deepEqual(order, ["history", "ack"]);

    await speak(creator, returning, {
      utteranceId: "utt-order-0002",
      text: "second",
      language: "en",
    });

    assert.deepEqual(order, ["history", "ack", "live"]);
    creator.disconnect();
    returning.disconnect();
  });

  it("never retains or replays interim lines", async () => {
    const creator = await connect();
    await callAck(creator, "room:create", { code: "HST236", language: "en" });
    const speaker = await connect();
    await callAck(speaker, "room:join", { code: "HST236", language: "en" });

    const partnerSawInterim = onceEvent(creator, "conversation:interim");
    speaker.emit("conversation:interim", {
      text: "half a sentence",
      language: "en",
    });
    await partnerSawInterim;
    speaker.disconnect();
    await delay(120);

    const returning = await connect();
    const historyPromise = onceEvent(returning, "conversation:history");
    await callAck(returning, "room:join", { code: "HST236", language: "en" });
    const [history] = await historyPromise;
    assert.deepEqual(history.entries, []);

    creator.disconnect();
    returning.disconnect();
  });

  it("does not duplicate rows when the same participant rejoins twice", async () => {
    const creator = await connect();
    await callAck(creator, "room:create", { code: "HST237", language: "en" });
    const speaker = await connect();
    await callAck(speaker, "room:join", { code: "HST237", language: "en" });
    await speak(speaker, creator, {
      utteranceId: "utt-once-0001",
      text: "only once",
      language: "en",
    });
    speaker.disconnect();
    await delay(120);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const rejoining = await connect();
      const historyPromise = onceEvent(rejoining, "conversation:history");
      await callAck(rejoining, "room:join", {
        code: "HST237",
        language: "en",
      });
      const [history] = await historyPromise;
      assert.equal(history.entries.length, 1);
      assert.equal(history.entries[0]?.utterance.id, "utt-once-0001");
      rejoining.disconnect();
      await delay(60);
    }

    creator.disconnect();
  });

  it("never sends another room's history", async () => {
    const creator = await connect();
    await callAck(creator, "room:create", { code: "HST238", language: "en" });
    const speaker = await connect();
    await callAck(speaker, "room:join", { code: "HST238", language: "en" });
    await speak(speaker, creator, {
      utteranceId: "utt-private-001",
      text: "private",
      language: "en",
    });

    const otherRoom = await connect();
    const leaks: unknown[] = [];
    otherRoom.on("conversation:history", (payload) => leaks.push(payload));
    const otherHistory = onceEvent(otherRoom, "conversation:history");
    await callAck(otherRoom, "room:create", {
      code: "HST239",
      language: "en",
    });
    const [history] = await otherHistory;
    assert.equal(history.code, "HST239");
    assert.deepEqual(history.entries, []);
    await delay(150);
    assert.equal(leaks.length, 1);

    // A refused join learns nothing about the room either.
    const outsider = await connect();
    const refusals: unknown[] = [];
    outsider.on("conversation:history", (payload) => refusals.push(payload));
    const full = await callAck(outsider, "room:join", {
      code: "HST238",
      language: "en",
    });
    assert.equal(full.ok, false);
    await delay(150);
    assert.deepEqual(refusals, []);

    creator.disconnect();
    speaker.disconnect();
    otherRoom.disconnect();
    outsider.disconnect();
  });

  it("keeps each seat's own languages across join, rejoin, and a partner change", async () => {
    const creator = await connect();
    const created = await callAck(creator, "room:create", {
      code: "HST242",
      language: "hi",
      listeningLanguage: "en",
    });
    assert.equal(created.ok, true, JSON.stringify(created));

    const guest = await connect();
    const guestState = onceEvent(guest, "room:state");
    const joined = await callAck(guest, "room:join", {
      code: "HST242",
      language: "ta",
      listeningLanguage: "hi",
    });
    assert.equal(joined.ok, true, JSON.stringify(joined));
    const [snapshot] = await guestState;
    assert.deepEqual(
      snapshot.participants.map((p) => [
        p.side,
        p.language,
        p.listeningLanguage,
      ]),
      [
        ["a", "hi", "en"],
        ["b", "ta", "hi"],
      ],
    );

    // A refusal leaves the other seat's preferences untouched.
    const rejected = await callAck(guest, "room:join", {
      code: "HST242",
      language: "xx",
    });
    assert.equal(rejected.ok, false);
    assert.equal(
      rejected.ok === false && rejected.error.code,
      "invalid_payload",
    );

    guest.disconnect();
    await delay(120);
    const replacement = await connect();
    const replacementState = onceEvent(replacement, "room:state");
    await callAck(replacement, "room:join", {
      code: "HST242",
      language: "te",
      listeningLanguage: "kn",
    });
    const [afterReplacement] = await replacementState;
    assert.deepEqual(
      afterReplacement.participants.map((p) => [
        p.side,
        p.language,
        p.listeningLanguage,
      ]),
      [
        ["a", "hi", "en"],
        ["b", "te", "kn"],
      ],
    );

    creator.disconnect();
    replacement.disconnect();
  });

  it("defaults a missing listening preference and rejects an invalid one", async () => {
    const creator = await connect();
    await callAck(creator, "room:create", {
      code: "HST243",
      language: "en",
    });
    const guest = await connect();
    const guestState = onceEvent(guest, "room:state");
    await callAck(guest, "room:join", { code: "HST243", language: "ta" });
    const [snapshot] = await guestState;
    const seatB = snapshot.participants.find((p) => p.side === "b");
    assert.equal(seatB?.language, "ta");
    assert.equal(seatB?.listeningLanguage, "en");

    const other = await connect();
    const bad = await callAck(other, "room:join", {
      code: "HST243",
      language: "en",
      listeningLanguage: "klingon",
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.ok === false && bad.error.code, "invalid_payload");

    creator.disconnect();
    guest.disconnect();
    other.disconnect();
  });
});
