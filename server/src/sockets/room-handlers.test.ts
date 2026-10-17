import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import {
  io as connectClient,
  type Socket as ClientSocket,
} from "socket.io-client";
import {
  createSangamServer,
  type SangamServer,
} from "../app.js";
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
  /** Server-assigned participant id of the joiner (side `b`). */
  readonly joinerParticipantId: string;
}

async function pair(code: string): Promise<RoomPair> {
  const creator = await connect();
  const joiner = await connect();
  const created = await callAck(creator, "room:create", {
    code,
    language: "en",
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const joinerStatePromise = onceEvent(joiner, "room:state");
  const joined = await callAck(joiner, "room:join", { code, language: "ta" });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  const [state] = await joinerStatePromise;
  const joinerParticipantId = state.participants.find(
    (p) => p.side === "b",
  )?.id;
  assert.ok(joinerParticipantId);
  return { creator, joiner, joinerParticipantId };
}

describe("socket room lifecycle", () => {
  it("creates a room, assigns side a, then side b to the joiner", async () => {
    const creator = await connect();
    const statePromise = onceEvent(creator, "room:state");
    const ack = await callAck(creator, "room:create", {
      code: "ABCDEF",
      language: "en",
    });
    assert.equal(ack.ok, true);
    assert.equal(ack.ok && ack.self.side, "a");
    assert.ok(ack.ok && ack.self.id.length > 0);
    const [state] = await statePromise;
    assert.equal(state.status, "waiting");
    assert.equal(state.participants.length, 1);
    assert.equal(state.participants[0]?.side, "a");
    assert.equal(state.participants[0]?.language, "en");

    const joiner = await connect();
    const joinerStatePromise = onceEvent(joiner, "room:state");
    const joinedPresence = onceEvent(creator, "room:participant_joined");
    const joinAck = await callAck(joiner, "room:join", {
      code: "ABCDEF",
      language: "ta",
    });
    assert.equal(joinAck.ok, true);
    const [joinerState] = await joinerStatePromise;
    assert.equal(joinerState.status, "live");
    assert.equal(
      joinerState.participants.find((p) => p.side === "b")?.language,
      "ta",
    );
    const [{ participant }] = await joinedPresence;
    assert.equal(participant.side, "b");
    assert.ok(participant.id.length > 0);
    creator.disconnect();
    joiner.disconnect();
  });

  it("rejects a third participant, unknown rooms, and malformed codes", async () => {
    const { creator, joiner } = await pair("GJKLMN");
    const third = await connect();

    const full = await callAck(third, "room:join", {
      code: "GJKLMN",
      language: "hi",
    });
    assert.equal(full.ok, false);
    assert.equal(full.ok === false && full.error.code, "room_full");

    const missing = await callAck(third, "room:join", {
      code: "ZZZ234",
      language: "hi",
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.ok === false && missing.error.code, "room_not_found");

    const malformed = await callAck(third, "room:join", {
      code: "nope!",
      language: "hi",
    });
    assert.equal(malformed.ok, false);
    assert.equal(
      malformed.ok === false && malformed.error.code,
      "invalid_code",
    );

    third.disconnect();
    creator.disconnect();
    joiner.disconnect();
  });

  it("relays an utterance to both parties with the sender's server side", async () => {
    const { creator, joiner } = await pair("PQRSTU");
    const creatorReceive = onceEvent(creator, "conversation:utterance");
    const joinerReceive = onceEvent(joiner, "conversation:utterance");

    joiner.emit("conversation:utterance", {
      utteranceId: "utt-joiner-0001",
      text: "  Vanakkam  ",
      language: "ta",
    });

    const [{ entry: fromJoiner }] = await joinerReceive;
    const [{ entry: creatorSees }] = await creatorReceive;
    assert.equal(fromJoiner.utterance.id, "utt-joiner-0001");
    assert.equal(fromJoiner.utterance.speakerSide, "b");
    assert.equal(fromJoiner.utterance.text, "Vanakkam");
    assert.equal(fromJoiner.utterance.sequence, 1);
    assert.equal(fromJoiner.translation.status, "unavailable");
    assert.equal(creatorSees.utterance.id, fromJoiner.utterance.id);
    assert.equal(creatorSees.utterance.sequence, 1);

    creator.disconnect();
    joiner.disconnect();
  });

  it("never delivers a message across rooms", async () => {
    const { creator: creatorA, joiner: joinerA } = await pair("UVWXYZ");
    const { creator: creatorB, joiner: joinerB } = await pair("234567");

    const leaks: unknown[] = [];
    creatorB.on("conversation:utterance", (payload) => leaks.push(payload));
    joinerB.on("conversation:utterance", (payload) => leaks.push(payload));

    const received = onceEvent(creatorA, "conversation:utterance");
    joinerA.emit("conversation:utterance", {
      utteranceId: "utt-secret-0001",
      text: "secret",
      language: "en",
    });
    await received;
    await delay(150);
    assert.deepEqual(leaks, []);

    creatorA.disconnect();
    joinerA.disconnect();
    creatorB.disconnect();
    joinerB.disconnect();
  });

  it("rejects payloads that try to spoof identity fields", async () => {
    const { creator, joiner } = await pair("89GHJK");
    const creatorLeaks: unknown[] = [];
    creator.on("conversation:utterance", (payload) =>
      creatorLeaks.push(payload),
    );

    const errorPromise = onceEvent(joiner, "error");
    joiner.emit("conversation:utterance", {
      text: "spoof",
      language: "en",
      side: "a",
    } as never);
    const [error] = await errorPromise;
    assert.equal(error.code, "invalid_payload");
    await delay(150);
    assert.deepEqual(creatorLeaks, []);

    const spoofAck = await new Promise<RoomOpAck>((resolve) => {
      joiner.emit(
        "room:join",
        { code: "89GHJK", language: "en", side: "a" } as never,
        (response: RoomOpAck) => resolve(response),
      );
    });
    assert.equal(spoofAck.ok, false);
    assert.equal(
      spoofAck.ok === false && spoofAck.error.code,
      "invalid_payload",
    );

    creator.disconnect();
    joiner.disconnect();
  });

  it("relays interrupts with the interrupter's server side", async () => {
    const { creator, joiner } = await pair("892345");
    const creatorSees = onceEvent(creator, "conversation:interrupt");
    joiner.emit("conversation:interrupt");
    const [{ side, sequence }] = await creatorSees;
    assert.equal(side, "b");
    // No utterance has been relayed yet, so the boundary is a pure stop.
    assert.equal(sequence, 0);

    const joinerSees = onceEvent(joiner, "conversation:interrupt");
    creator.emit("conversation:interrupt");
    const [{ side: creatorSide }] = await joinerSees;
    assert.equal(creatorSide, "a");

    creator.disconnect();
    joiner.disconnect();
  });

  it("announces leave and unexpected disconnects to the partner", async () => {
    const { creator, joiner, joinerParticipantId } = await pair("GHJKLM");

    const left = onceEvent(creator, "room:participant_left");
    joiner.emit("room:leave", { code: "GHJKLM" });
    const [departure] = await left;
    assert.equal(departure.participantId, joinerParticipantId);

    const replacement = await connect();
    const replacementState = onceEvent(replacement, "room:state");
    const rejoin = await callAck(replacement, "room:join", {
      code: "GHJKLM",
      language: "es",
    });
    assert.equal(rejoin.ok, true);
    const [replacementSnap] = await replacementState;
    const replacementParticipantId = replacementSnap.participants.find(
      (p) => p.side === "b",
    )?.id;
    assert.ok(replacementParticipantId);

    const dropped = onceEvent(creator, "room:participant_left");
    replacement.disconnect();
    const [drop] = await dropped;
    assert.equal(drop.participantId, replacementParticipantId);

    creator.disconnect();
  });

  it("treats duplicate joins as idempotent", async () => {
    const creator = await connect();
    await callAck(creator, "room:create", { code: "NPQRST", language: "en" });
    const joiner = await connect();
    await callAck(joiner, "room:join", { code: "NPQRST", language: "fr" });

    const arrivals: unknown[] = [];
    creator.on("room:participant_joined", (payload) => arrivals.push(payload));

    const secondAck = await callAck(joiner, "room:join", {
      code: "NPQRST",
      language: "fr",
    });
    assert.equal(secondAck.ok, true);
    await delay(150);
    assert.equal(arrivals.length, 1);

    creator.disconnect();
    joiner.disconnect();
  });

  it("rejects utterances from sockets that never joined", async () => {
    const lonely = await connect();
    const errorPromise = onceEvent(lonely, "error");
    lonely.emit("conversation:utterance", {
      utteranceId: "utt-lonely-001",
      text: "hi",
      language: "en",
    });
    const [error] = await errorPromise;
    assert.equal(error.code, "not_in_room");
    lonely.disconnect();
  });
});
