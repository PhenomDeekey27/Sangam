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
  SpeechStartAck,
} from "../sockets/contract.js";

type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

let server: SangamServer;
let url: string;

before(async () => {
  server = createSangamServer({
    port: 0,
    clientOrigins: ["http://localhost:3000"],
    isProduction: false,
    speech: { provider: "mock" },
  });
  await server.listen();
  const address = server.httpServer.address() as AddressInfo;
  url = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await server.close();
});

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

function join(
  socket: TestClient,
  event: "room:create" | "room:join",
  payload: { code: string; language: string; listeningLanguage?: string },
): Promise<RoomOpAck> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (response: RoomOpAck) => resolve(response));
  });
}

function startSpeech(
  socket: TestClient,
  payload: { language: string; mimeType?: string },
): Promise<SpeechStartAck> {
  return new Promise((resolve) => {
    socket.emit("speech:start", payload, (response: SpeechStartAck) =>
      resolve(response),
    );
  });
}

/** Connect and wait for the capabilities handshake (implies connected). */
async function connectWithCapabilities(): Promise<TestClient> {
  const socket = connectClient(url, {
    transports: ["websocket"],
    reconnection: false,
  });
  return new Promise((resolve, reject) => {
    socket.once("connect_error", reject);
    socket.once("speech:capabilities", () => resolve(socket));
  });
}

/** Capabilities handshake payload for assertions. */
function capabilities(): Promise<
  Parameters<ServerToClientEvents["speech:capabilities"]>[0]
> {
  const socket = connectClient(url, {
    transports: ["websocket"],
    reconnection: false,
  });
  return new Promise((resolve, reject) => {
    socket.once("connect_error", reject);
    socket.once("speech:capabilities", (caps) => {
      socket.disconnect();
      resolve(caps);
    });
  });
}

describe("speech:capabilities", () => {
  it("advertises the server pipeline and its languages", async () => {
    const caps = await capabilities();
    assert.equal(caps.provider, "mock");
    assert.equal(caps.streaming, true);
    assert.equal(caps.interim, true);
    for (const language of ["ta", "te", "hi", "en"]) {
      assert.ok(caps.languages.includes(language), language);
    }
  });
});

describe("server speech pipeline", () => {
  it("runs the Tamil/Telugu invite scenario end to end", async () => {
    // Person A creates: speaks Tamil, hears Telugu.
    const creator = await connectWithCapabilities();
    const created = await join(creator, "room:create", {
      code: "SPK234",
      language: "ta",
      listeningLanguage: "te",
    });
    assert.equal(created.ok, true, JSON.stringify(created));

    // Person B follows the invite: speaks Telugu, hears Tamil.
    const guest = await connectWithCapabilities();
    const guestState = onceEvent(guest, "room:state");
    const joined = await join(guest, "room:join", {
      code: "SPK234",
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

    // Each seat opens recognition explicitly in its own language.
    const creatorStart = await startSpeech(creator, {
      language: "ta",
      mimeType: "audio/webm",
    });
    const guestStart = await startSpeech(guest, {
      language: "te",
      mimeType: "audio/webm",
    });
    assert.deepEqual(creatorStart, { ok: true, language: "ta" });
    assert.deepEqual(guestStart, { ok: true, language: "te" });

    // A final reaches both participants exactly once.
    const creatorSees = onceEvent(creator, "conversation:utterance");
    const guestSees = onceEvent(guest, "conversation:utterance");
    const creatorInterim = onceEvent(guest, "conversation:interim");
    creator.emit("speech:audio", new Uint8Array([1, 2, 3, 4]).buffer);

    const [{ entry }] = await creatorSees;
    const [{ entry: guestEntry }] = await guestSees;
    const [{ side, text }] = await creatorInterim;
    assert.equal(entry.utterance.speakerSide, "a");
    assert.equal(entry.utterance.language, "ta");
    assert.equal(entry.utterance.text, "[mock] recognized ta");
    assert.equal(guestEntry.utterance.id, entry.utterance.id);
    assert.equal(side, "a");
    assert.equal(text, "[mock] hearing ta…");

    // No duplicate row is relayed for the same final.
    const duplicates: unknown[] = [];
    guest.on("conversation:utterance", (payload) => duplicates.push(payload));
    await delay(120);
    assert.deepEqual(duplicates, []);

    creator.disconnect();
    guest.disconnect();
  });

  it("refuses a start for a language the seat did not record", async () => {
    const creator = await connectWithCapabilities();
    await join(creator, "room:create", { code: "SPK235", language: "hi" });
    const refusal = await startSpeech(creator, { language: "ta" });
    assert.equal(refusal.ok, false);
    assert.equal(
      refusal.ok === false && refusal.error.code,
      "language_mismatch",
    );
    creator.disconnect();
  });

  it("refuses speech from a socket that never joined a room", async () => {
    const lonely = await connectWithCapabilities();
    const refusal = await startSpeech(lonely, { language: "en" });
    assert.equal(refusal.ok, false);
    assert.equal(refusal.ok === false && refusal.error.code, "not_in_room");
    lonely.disconnect();
  });

  it("rejects an unsupported audio metadata claim", async () => {
    const creator = await connectWithCapabilities();
    await join(creator, "room:create", { code: "SPK236", language: "en" });
    const refusal = await startSpeech(creator, {
      language: "en",
      mimeType: "video/mp4",
    });
    assert.equal(refusal.ok, false);
    assert.equal(refusal.ok === false && refusal.error.code, "invalid_payload");
    creator.disconnect();
  });

  it("stops relaying to a participant who disconnects mid-session", async () => {
    const creator = await connectWithCapabilities();
    await join(creator, "room:create", { code: "SPK237", language: "en" });
    const guest = await connectWithCapabilities();
    await join(guest, "room:join", { code: "SPK237", language: "ta" });
    await startSpeech(guest, { language: "ta", mimeType: "audio/webm" });

    // The guest leaves; the creator must not receive anything from that seat.
    const leaks: unknown[] = [];
    creator.on("conversation:utterance", (payload) => leaks.push(payload));
    creator.on("conversation:interim", (payload) => leaks.push(payload));
    guest.disconnect();
    await delay(120);
    assert.deepEqual(leaks, []);
    creator.disconnect();
  });
});
