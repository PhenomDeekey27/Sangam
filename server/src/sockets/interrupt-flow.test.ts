/**
 * Wire-level behavior for the interruption round trip: request → relay →
 * confirmation back to the requester. Kept separate from the broader room
 * lifecycle suite for file length.
 */
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
  InterruptAck,
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

function interruptRequest(
  socket: TestClient,
  interruptId: string,
): Promise<InterruptAck> {
  return new Promise((resolve) => {
    socket.emit("conversation:interrupt", { interruptId }, (response) =>
      resolve(response),
    );
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
  const created = await callAck(creator, "room:create", { code, language: "en" });
  assert.equal(created.ok, true, JSON.stringify(created));
  const joined = await callAck(joiner, "room:join", { code, language: "ta" });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  return { creator, joiner };
}

describe("interruption round trip", () => {
  it("relays the request with its correlation id and acks the requester", async () => {
    const { creator, joiner } = await pair("ACK234");
    const relayed = onceEvent(joiner, "conversation:interrupt");

    const ack = await interruptRequest(creator, "int-ack-1");
    assert.deepEqual(ack, {
      ok: true,
      interruptId: "int-ack-1",
      relayed: true,
    });

    const [payload] = await relayed;
    assert.equal(payload.side, "a");
    assert.equal(payload.interruptId, "int-ack-1");

    creator.disconnect();
    joiner.disconnect();
  });

  it("routes the partner's confirmation back to the requester", async () => {
    const { creator, joiner } = await pair("CNF234");
    const relayed = onceEvent(joiner, "conversation:interrupt");
    await interruptRequest(creator, "int-conf-1");
    await relayed;

    const confirmed = onceEvent(creator, "conversation:interrupt_confirmed");
    joiner.emit("conversation:interrupt_ack", { interruptId: "int-conf-1" });
    const [payload] = await confirmed;
    // `side` names the interrupted partner, so the requester knows who
    // actually cancelled their playback.
    assert.equal(payload.side, "b");
    assert.equal(payload.interruptId, "int-conf-1");

    creator.disconnect();
    joiner.disconnect();
  });

  it("reports an interruption as unrelayed when alone in the room", async () => {
    const solo = await connect();
    const created = await callAck(solo, "room:create", {
      code: "ALN234",
      language: "en",
    });
    assert.equal(created.ok, true);

    const ack = await interruptRequest(solo, "int-aln-1");
    assert.deepEqual(ack, {
      ok: true,
      interruptId: "int-aln-1",
      relayed: false,
    });

    solo.disconnect();
  });

  it("refuses a malformed request without relaying it", async () => {
    const { creator, joiner } = await pair("BAD234");
    let sawRelay = false;
    joiner.on("conversation:interrupt", () => {
      sawRelay = true;
    });

    // Too short to be a valid correlation id: rejected before any relay.
    const bad = await new Promise<InterruptAck>((resolve) => {
      creator.emit("conversation:interrupt", { interruptId: "x" }, (response) =>
        resolve(response),
      );
    });
    assert.equal(bad.ok, false);
    await delay(100);
    assert.equal(sawRelay, false);

    creator.disconnect();
    joiner.disconnect();
  });

  it("ignores a confirmation for an unknown request id", async () => {
    const { creator, joiner } = await pair("STA234");
    let confirmed = false;
    creator.on("conversation:interrupt_confirmed", () => {
      confirmed = true;
    });

    joiner.emit("conversation:interrupt_ack", { interruptId: "int-none-1" });
    await delay(150);
    assert.equal(confirmed, false);

    creator.disconnect();
    joiner.disconnect();
  });

  it("does not let the requester confirm its own request", async () => {
    const { creator, joiner } = await pair("SLF234");
    await interruptRequest(creator, "int-self-1");
    let confirmed = false;
    creator.on("conversation:interrupt_confirmed", () => {
      confirmed = true;
    });

    creator.emit("conversation:interrupt_ack", { interruptId: "int-self-1" });
    await delay(150);
    assert.equal(confirmed, false);

    creator.disconnect();
    joiner.disconnect();
  });
});
