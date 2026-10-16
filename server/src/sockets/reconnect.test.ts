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

function callAck(
  socket: TestClient,
  event: "room:create" | "room:join",
  payload: { code: string; language: string; listeningLanguage?: string },
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

/**
 * Transport loss and recovery against one live room manager: drops are
 * announced, survivors rejoin with their own preferences intact, and a
 * backend restart (fresh process, empty memory) reads as `room_not_found`
 * rather than a seat, a guess, or a hang.
 */
describe("disconnect and reconnect", () => {
  it("tells the partner when a member's transport drops mid-room", async () => {
    const creator = await connect();
    await callAck(creator, "room:create", {
      code: "RCN234",
      language: "fr",
      listeningLanguage: "pa",
    });
    const guest = await connect();
    const joined = await callAck(guest, "room:join", {
      code: "RCN234",
      language: "pa",
      listeningLanguage: "fr",
    });
    assert.equal(joined.ok, true, JSON.stringify(joined));
    const guestId = joined.ok === true ? joined.self.id : null;

    const left = onceEvent(creator, "room:participant_left");
    guest.disconnect();
    const [{ participantId }] = await left;
    assert.equal(participantId, guestId);

    creator.disconnect();
  });

  it("reseats a reconnecting guest with the same preferences, once", async () => {
    const creator = await connect();
    await callAck(creator, "room:create", {
      code: "RCN235",
      language: "fr",
      listeningLanguage: "pa",
    });
    const guest = await connect();
    await callAck(guest, "room:join", {
      code: "RCN235",
      language: "pa",
      listeningLanguage: "fr",
    });
    // Transport drops; the guest comes back on a fresh socket (as after a
    // refresh) and explicitly rejoins with the same pair.
    guest.disconnect();
    const returned = await connect();
    const state = onceEvent(returned, "room:state");
    const rejoined = await callAck(returned, "room:join", {
      code: "RCN235",
      language: "pa",
      listeningLanguage: "fr",
    });
    assert.equal(rejoined.ok, true, JSON.stringify(rejoined));
    const [snapshot] = await state;
    // Exactly one row per side: no duplicate joins, creator untouched,
    // and each seat keeps its own languages for recognition.
    assert.deepEqual(
      snapshot.participants.map((p) => [
        p.side,
        p.language,
        p.listeningLanguage,
      ]),
      [
        ["a", "fr", "pa"],
        ["b", "pa", "fr"],
      ],
    );

    creator.disconnect();
    returned.disconnect();
  });

  it("joins twice from one socket without duplicating the seat", async () => {
    const creator = await connect();
    await callAck(creator, "room:create", {
      code: "RCN236",
      language: "fr",
      listeningLanguage: "pa",
    });
    const first = await callAck(creator, "room:join", {
      code: "RCN236",
      language: "fr",
      listeningLanguage: "pa",
    });
    const second = await callAck(creator, "room:join", {
      code: "RCN236",
      language: "fr",
      listeningLanguage: "pa",
    });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(second.ok, true, JSON.stringify(second));
    if (first.ok !== true || second.ok !== true) throw new Error("unreachable");
    assert.equal(first.self.id, second.self.id);
    assert.equal(first.self.side, "a");
    const room = server.rooms.roomByCode("RCN236");
    assert.ok(room);
    assert.equal(room.participants.size, 1);

    creator.disconnect();
  });

  it("answers room_not_found when a restart wiped the room", async () => {
    // A room lives only in its process's memory: a fresh server for the
    // same code stands in for a restarted backend.
    const original = createSangamServer({
      port: 0,
      clientOrigins: ["http://localhost:3000"],
      isProduction: false,
    });
    await original.listen();
    const address = original.httpServer.address() as AddressInfo;
    const originalUrl = `http://127.0.0.1:${address.port}`;
    const before = await new Promise<TestClient>((resolve, reject) => {
      const socket = connectClient(originalUrl, {
        transports: ["websocket"],
        reconnection: false,
      });
      socket.once("connect", () => resolve(socket));
      socket.once("connect_error", reject);
    });
    const created = await new Promise<RoomOpAck>((resolve) => {
      before.emit(
        "room:create",
        { code: "RCN237", language: "fr", listeningLanguage: "pa" },
        (response: RoomOpAck) => resolve(response),
      );
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    before.disconnect();
    await original.close();

    const restarted = createSangamServer({
      port: 0,
      clientOrigins: ["http://localhost:3000"],
      isProduction: false,
    });
    await restarted.listen();
    const restartedAddress = restarted.httpServer.address() as AddressInfo;
    const restartedUrl = `http://127.0.0.1:${restartedAddress.port}`;
    const after = await new Promise<TestClient>((resolve, reject) => {
      const socket = connectClient(restartedUrl, {
        transports: ["websocket"],
        reconnection: false,
      });
      socket.once("connect", () => resolve(socket));
      socket.once("connect_error", reject);
    });
    const rejoined = await new Promise<RoomOpAck>((resolve) => {
      after.emit(
        "room:join",
        { code: "RCN237", language: "fr", listeningLanguage: "pa" },
        (response: RoomOpAck) => resolve(response),
      );
    });
    assert.equal(rejoined.ok, false);
    if (rejoined.ok !== false) throw new Error("unreachable");
    assert.equal(rejoined.error.code, "room_not_found");

    after.disconnect();
    await restarted.close();
  });
});
