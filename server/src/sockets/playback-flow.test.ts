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
import {
  MockTtsProvider,
  fakeWavBytes,
} from "../tts/mock-tts-provider.js";
import { MockTranslator } from "../translation/mock-translator.js";

type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

let server: SangamServer;
let url: string;

/**
 * Scripted vendors: canned French ↔ Punjabi and Tamil ↔ English pairs plus a
 * mock TTS provider, so the whole playback path runs without any network.
 */
const translator = new MockTranslator({
  canned: {
    fr: {
      pa: { Bonjour: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ" },
    },
    pa: {
      fr: { "ਸਤ ਸ੍ਰੀ ਅਕਾਲ": "Bonjour" },
    },
    ta: {
      en: { "வணக்கம்": "Hello" },
    },
    en: {
      ta: { Hello: "வணக்கம்" },
    },
  },
});
const tts = new MockTtsProvider();

before(async () => {
  server = createSangamServer(
    {
      port: 0,
      clientOrigins: ["http://localhost:3000"],
      isProduction: false,
    },
    { translator, ttsProvider: tts },
  );
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
  timeoutMs = 3000,
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

/** Seat a French↔Punjabi room and return both sockets. */
async function frenchPunjabiPair(
  code: string,
): Promise<[TestClient, TestClient]> {
  const creator = await connect();
  await callAck(creator, "room:create", {
    code,
    language: "fr",
    listeningLanguage: "fr",
  });
  const guest = await connect();
  await callAck(guest, "room:join", {
    code,
    language: "pa",
    listeningLanguage: "pa",
  });
  return [creator, guest];
}

describe("translated-speech playback flow (mocked vendors)", () => {
  it("delivers synthesized audio to the listener only, never the speaker", async () => {
    const [creator, guest] = await frenchPunjabiPair("PBF234");

    const translated = onceEvent(guest, "conversation:translation");
    const playback = onceEvent(guest, "conversation:playback");
    creator.emit("conversation:utterance", {
      utteranceId: "utt-pb-fr-01",
      text: "Bonjour",
      language: "fr",
    });
    const [payload, audio] = await playback;
    await translated;

    assert.equal(payload.utteranceId, "utt-pb-fr-01");
    assert.equal(payload.language, "pa");
    assert.equal(payload.mimeType, "audio/wav");
    assert.ok(payload.sequence >= 1);
    assert.deepEqual([...new Uint8Array(audio)], [...fakeWavBytes("ਸਤ ਸ੍ਰੀ ਅਕਾਲ")]);

    // The speaker never hears their own translation.
    let speakerPlaybackReceived = false;
    creator.on("conversation:playback", () => {
      speakerPlaybackReceived = true;
    });
    await delay(120);
    assert.equal(speakerPlaybackReceived, false);

    // Each vendor ran exactly once for this utterance.
    assert.equal(tts.calls.filter((c) => c.text === "ਸਤ ਸ੍ਰੀ ਅਕਾਲ").length, 1);

    creator.disconnect();
    guest.disconnect();
  });

  it("never repeats playback for a re-played or re-translated utterance id", async () => {
    const [creator, guest] = await frenchPunjabiPair("PCF234");

    const first = onceEvent(guest, "conversation:playback");
    creator.emit("conversation:utterance", {
      utteranceId: "utt-pb-fr-02",
      text: "Bonjour",
      language: "fr",
    });
    await first;

    // A repeated id is refused at the room level and reaches neither the
    // translation vendor nor the speech vendor a second time.
    const refused = onceEvent(creator, "error");
    const synthesisCalls = tts.calls.length;
    creator.emit("conversation:utterance", {
      utteranceId: "utt-pb-fr-02",
      text: "Bonjour",
      language: "fr",
    });
    await refused;
    await delay(150);
    assert.equal(tts.calls.length, synthesisCalls);

    let playbackCount = 0;
    guest.on("conversation:playback", () => {
      playbackCount += 1;
    });
    await delay(150);
    assert.equal(playbackCount, 0);

    creator.disconnect();
    guest.disconnect();
  });

  it("keeps the translated text in history replay without re-emitting audio", async () => {
    const [creator, guest] = await frenchPunjabiPair("PDF234");

    const translated = onceEvent(guest, "conversation:translation");
    const playback = onceEvent(guest, "conversation:playback");
    creator.emit("conversation:utterance", {
      utteranceId: "utt-pb-fr-03",
      text: "Bonjour",
      language: "fr",
    });
    await translated;
    await playback;

    // The rejoining seat replays the *text* only — never the audio.
    guest.disconnect();
    await delay(50);
    const rejoiner = await connect();
    const history = onceEvent(rejoiner, "conversation:history");
    await callAck(rejoiner, "room:join", {
      code: "PDF234",
      language: "pa",
      listeningLanguage: "pa",
    });
    const [{ entries }] = await history;
    const replayed = entries.find((row) => row.utterance.id === "utt-pb-fr-03");
    assert.ok(replayed);
    assert.deepEqual(replayed.translation, {
      status: "complete",
      text: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ",
      targetLanguage: "pa",
    });
    let replayPlaybackCount = 0;
    rejoiner.on("conversation:playback", () => {
      replayPlaybackCount += 1;
    });
    await delay(150);
    assert.equal(replayPlaybackCount, 0);

    creator.disconnect();
    rejoiner.disconnect();
  });

  it("drives Tamil ↔ English playback for the Tamil listener", async () => {
    const creator = await connect();
    await callAck(creator, "room:create", {
      code: "PBT234",
      language: "en",
      listeningLanguage: "en",
    });
    const guest = await connect();
    await callAck(guest, "room:join", {
      code: "PBT234",
      language: "ta",
      listeningLanguage: "ta",
    });

    const playback = onceEvent(guest, "conversation:playback");
    creator.emit("conversation:utterance", {
      utteranceId: "utt-pb-ta-01",
      text: "Hello",
      language: "en",
    });
    const [payload, audio] = await playback;
    assert.equal(payload.language, "ta");
    assert.deepEqual([...new Uint8Array(audio)], [...fakeWavBytes("வணக்கம்")]);

    creator.disconnect();
    guest.disconnect();
  });

  it("delivers nothing when there is no TTS provider configured", async () => {
    // A null TTS provider is wired through the same code path on a fresh
    // server instance so the two-seat flow cannot smuggle audio out.
    const quietRoom = createSangamServer(
      {
        port: 0,
        clientOrigins: ["http://localhost:3000"],
        isProduction: false,
      },
      { translator, ttsProvider: null },
    );
    await quietRoom.listen();
    const address = quietRoom.httpServer.address() as AddressInfo;
    const quietUrl = `http://127.0.0.1:${address.port}`;

    const connectTo = (target: string): Promise<TestClient> =>
      new Promise((resolve, reject) => {
        const socket = connectClient(target, {
          transports: ["websocket"],
          reconnection: false,
        });
        socket.once("connect", () => resolve(socket));
        socket.once("connect_error", reject);
      });

    const creator = await connectTo(quietUrl);
    await new Promise<RoomOpAck>((resolve) =>
      creator.emit(
        "room:create",
        { code: "PBQ234", language: "fr", listeningLanguage: "fr" },
        resolve,
      ),
    );
    const guest = await connectTo(quietUrl);
    await new Promise<RoomOpAck>((resolve) =>
      guest.emit(
        "room:join",
        { code: "PBQ234", language: "pa", listeningLanguage: "pa" },
        resolve,
      ),
    );

    const translated = onceEvent(guest, "conversation:translation");
    const unavailable = onceEvent(guest, "conversation:playback_unavailable");
    creator.emit("conversation:utterance", {
      utteranceId: "utt-pb-quiet-01",
      text: "Bonjour",
      language: "fr",
    });
    await translated;
    const [unavailablePayload] = await unavailable;
    assert.equal(unavailablePayload.utteranceId, "utt-pb-quiet-01");
    assert.equal(unavailablePayload.language, "pa");
    assert.equal(unavailablePayload.reason, "provider_unavailable");
    assert.ok(unavailablePayload.sequence >= 1);

    let playbackCount = 0;
    guest.on("conversation:playback", () => {
      playbackCount += 1;
    });
    await delay(150);
    assert.equal(playbackCount, 0);

    creator.disconnect();
    guest.disconnect();
    await quietRoom.close();
  });

  it("reports unsupported_language when no configured voice covers the target", async () => {
    // A provider that only speaks Tamil cannot serve seat B's Punjabi target.
    const restricted = new MockTtsProvider({ languages: ["ta"] });
    const restrictedServer = createSangamServer(
      {
        port: 0,
        clientOrigins: ["http://localhost:3000"],
        isProduction: false,
      },
      { translator, ttsProvider: restricted },
    );
    await restrictedServer.listen();
    const address = restrictedServer.httpServer.address() as AddressInfo;
    const restrictedUrl = `http://127.0.0.1:${address.port}`;

    const connectTo = (target: string): Promise<TestClient> =>
      new Promise((resolve, reject) => {
        const socket = connectClient(target, {
          transports: ["websocket"],
          reconnection: false,
        });
        socket.once("connect", () => resolve(socket));
        socket.once("connect_error", reject);
      });

    const creator = await connectTo(restrictedUrl);
    await new Promise<RoomOpAck>((resolve) =>
      creator.emit(
        "room:create",
        { code: "PBU234", language: "fr", listeningLanguage: "fr" },
        resolve,
      ),
    );
    const guest = await connectTo(restrictedUrl);
    await new Promise<RoomOpAck>((resolve) =>
      guest.emit(
        "room:join",
        { code: "PBU234", language: "pa", listeningLanguage: "pa" },
        resolve,
      ),
    );

    const unavailable = onceEvent(guest, "conversation:playback_unavailable");
    creator.emit("conversation:utterance", {
      utteranceId: "utt-pb-unsupported-01",
      text: "Bonjour",
      language: "fr",
    });
    const [payload] = await unavailable;
    assert.equal(payload.reason, "unsupported_language");
    assert.equal(payload.language, "pa");
    assert.equal(restricted.calls.length, 0);

    creator.disconnect();
    guest.disconnect();
    await restrictedServer.close();
  });
});
