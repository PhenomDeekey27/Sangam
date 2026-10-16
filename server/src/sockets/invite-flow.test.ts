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
 * The wire leg of create → invite → join over real sockets: payloads in,
 * seats and snapshots out. The URL leg (landing selectors → room URL → invite
 * link → parsed preferences) is composed from the real helpers in the
 * frontend `invite-flow` test; the mirrored pair used here (`ta`/`te` →
 * `te`/`ta`) is pinned there, so this file asserts what the server does with
 * those exact preferences.
 */
describe("create → invite → join preserves both participants' languages", () => {
  it("seats Person B with the mirrored preferences from the invite link", async () => {
    // Person A created the room speaking Tamil and hearing Telugu.
    const creator = await connect();
    const created = await callAck(creator, "room:create", {
      code: "VWX234",
      language: "ta",
      listeningLanguage: "te",
    });
    assert.equal(created.ok, true, JSON.stringify(created));

    // Person B opens the exact invite link (`speak=te&hear=ta`): Telugu/Tamil,
    // no English anywhere.
    const guest = await connect();
    const guestState = onceEvent(guest, "room:state");
    const joined = await callAck(guest, "room:join", {
      code: "VWX234",
      language: "te",
      listeningLanguage: "ta",
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
        ["a", "ta", "te"],
        ["b", "te", "ta"],
      ],
    );
    for (const participant of snapshot.participants) {
      assert.notEqual(participant.language, "en");
      assert.notEqual(participant.listeningLanguage, "en");
    }

    creator.disconnect();
    guest.disconnect();
  });

  it("joins by bare code with the documented default, never fake invite prefs", async () => {
    // No language parameters at all: the documented default (`en`/`en`,
    // pinned in the frontend invite-flow test) applies. This pins that a
    // code-only join is honest about what it received — it must not pretend
    // the invite preferences arrived when they did not.
    const creator = await connect();
    await callAck(creator, "room:create", {
      code: "VWX235",
      language: "ta",
      listeningLanguage: "es",
    });
    const guest = await connect();
    const guestState = onceEvent(guest, "room:state");
    await callAck(guest, "room:join", {
      code: "VWX235",
      language: "en",
      listeningLanguage: "en",
    });
    const [snapshot] = await guestState;
    const seatA = snapshot.participants.find((p) => p.side === "a");
    const seatB = snapshot.participants.find((p) => p.side === "b");
    assert.deepEqual([seatA?.language, seatA?.listeningLanguage], ["ta", "es"]);
    assert.deepEqual([seatB?.language, seatB?.listeningLanguage], ["en", "en"]);

    creator.disconnect();
    guest.disconnect();
  });

  it("refreshes the same seat when the socket rejoins with new preferences", async () => {
    const creator = await connect();
    const created = await callAck(creator, "room:create", {
      code: "VWX236",
      language: "en",
      listeningLanguage: "en",
    });
    assert.equal(created.ok, true, JSON.stringify(created));

    // Same socket, same room, new preferences (a same-tab invite-link paste
    // re-sends the join): the seat follows without changing sides.
    const refreshedState = onceEvent(creator, "room:state");
    const rejoined = await callAck(creator, "room:join", {
      code: "VWX236",
      language: "es",
      listeningLanguage: "ta",
    });
    assert.equal(rejoined.ok, true, JSON.stringify(rejoined));
    assert.equal(rejoined.ok === true && rejoined.self.side, "a");
    const [snapshot] = await refreshedState;
    const seatA = snapshot.participants.find((p) => p.side === "a");
    assert.deepEqual([seatA?.language, seatA?.listeningLanguage], ["es", "ta"]);

    creator.disconnect();
  });

  it("relays a repeated utterance id once and refuses the replay", async () => {
    const creator = await connect();
    await callAck(creator, "room:create", { code: "VWX237", language: "en" });
    const guest = await connect();
    await callAck(guest, "room:join", { code: "VWX237", language: "en" });

    const seen: unknown[] = [];
    guest.on("conversation:utterance", (payload) => seen.push(payload));
    const relayed = onceEvent(guest, "conversation:utterance");
    const refused = onceEvent(creator, "error");
    const payload = {
      utteranceId: "utt-invite-dedupe-01",
      text: "hello",
      language: "en",
    };
    creator.emit("conversation:utterance", payload);
    await relayed;
    creator.emit("conversation:utterance", payload);
    await refused;
    assert.equal(seen.length, 1);

    creator.disconnect();
    guest.disconnect();
  });
});
