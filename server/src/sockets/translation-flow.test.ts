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
import { MockTranslator } from "../translation/mock-translator.js";

type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

let server: SangamServer;
let url: string;

/**
 * Scripted vendor stand-in: canned French ↔ Punjabi pairs plus one scripted
 * failure. Clearly mocked — real-vendor verification is manual (see report).
 */
const translator = new MockTranslator({
  canned: {
    fr: {
      pa: {
        Bonjour: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ",
        "Comment vas-tu?": "ਤੁਸੀਂ ਕਿਵੇਂ ਹੋ?",
      },
    },
    pa: {
      fr: {
        "ਸਤ ਸ੍ਰੀ ਅਕਾਲ": "Bonjour",
      },
    },
  },
  failures: {
    fr: { pa: { "raté-test": "rate_limited" } },
  },
});

before(async () => {
  server = createSangamServer(
    {
      port: 0,
      clientOrigins: ["http://localhost:3000"],
      isProduction: false,
    },
    { translator },
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

describe("translated conversation flow (mocked vendor)", () => {
  it("delivers the original before the French → Punjabi translation", async () => {
    const creator = await connect();
    await callAck(creator, "room:create", {
      code: "TRF234",
      language: "fr",
      listeningLanguage: "fr",
    });
    const guest = await connect();
    await callAck(guest, "room:join", {
      code: "TRF234",
      language: "pa",
      listeningLanguage: "pa",
    });

    // Person A speaks French; Person B listens in Punjabi.
    const seen: Array<{ type: string; utteranceId?: string }> = [];
    guest.on("conversation:utterance", (payload) =>
      seen.push({ type: "utterance", utteranceId: payload.entry.utterance.id }),
    );
    const translated = onceEvent(guest, "conversation:translation");
    creator.emit("conversation:utterance", {
      utteranceId: "utt-flow-fr-01",
      text: "Bonjour",
      language: "fr",
    });
    const [{ utteranceId, translation }] = await translated;

    assert.equal(utteranceId, "utt-flow-fr-01");
    // The original row arrived first, untranslated.
    assert.deepEqual(
      seen.map((item) => item.type),
      ["utterance"],
    );
    assert.equal(seen[0]?.utteranceId, "utt-flow-fr-01");
    assert.deepEqual(translation, {
      status: "complete",
      text: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ",
      targetLanguage: "pa",
    });

    // Preferences on both seats are untouched by translation.
    const room = server.rooms.roomByCode("TRF234");
    assert.ok(room);
    assert.deepEqual(
      server.rooms
        .snapshot(room)
        .participants.map((p) => [p.side, p.language, p.listeningLanguage]),
      [
        ["a", "fr", "fr"],
        ["b", "pa", "pa"],
      ],
    );

    creator.disconnect();
    guest.disconnect();
  });

  it("translates Punjabi → French only for the listening seat", async () => {
    const creator = await connect();
    await callAck(creator, "room:create", {
      code: "TRF235",
      language: "fr",
      listeningLanguage: "fr",
    });
    const guest = await connect();
    await callAck(guest, "room:join", {
      code: "TRF235",
      language: "pa",
      listeningLanguage: "pa",
    });

    const guestTranslations: unknown[] = [];
    guest.on("conversation:translation", (payload) =>
      guestTranslations.push(payload),
    );
    const creatorTranslation = onceEvent(creator, "conversation:translation");
    guest.emit("conversation:utterance", {
      utteranceId: "utt-flow-pa-01",
      text: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ",
      language: "pa",
    });
    const [{ utteranceId, translation }] = await creatorTranslation;
    assert.equal(utteranceId, "utt-flow-pa-01");
    assert.deepEqual(translation, {
      status: "complete",
      text: "Bonjour",
      targetLanguage: "fr",
    });
    // The speaker's own socket never receives a translation event.
    await delay(120);
    assert.deepEqual(guestTranslations, []);

    creator.disconnect();
    guest.disconnect();
  });

  it("marks failure without touching the original text", async () => {
    const creator = await connect();
    await callAck(creator, "room:create", {
      code: "TRF236",
      language: "fr",
      listeningLanguage: "fr",
    });
    const guest = await connect();
    await callAck(guest, "room:join", {
      code: "TRF236",
      language: "pa",
      listeningLanguage: "pa",
    });

    const uttered = onceEvent(guest, "conversation:utterance");
    const translated = onceEvent(guest, "conversation:translation");
    creator.emit("conversation:utterance", {
      utteranceId: "utt-flow-fr-02",
      text: "raté-test",
      language: "fr",
    });
    const [{ entry }] = await uttered;
    assert.equal(entry.utterance.text, "raté-test");
    assert.equal(entry.translation.status, "unavailable");
    const [{ utteranceId, translation }] = await translated;
    assert.equal(utteranceId, "utt-flow-fr-02");
    assert.deepEqual(translation, {
      status: "failed",
      error: {
        code: "provider_error",
        message: "Translation failed — showing the original.",
      },
    });
    const stored = server.rooms
      .roomByCode("TRF236")
      ?.transcript.find((row) => row.utterance.id === "utt-flow-fr-02");
    assert.equal(stored?.utterance.text, "raté-test");
    assert.equal(stored?.translation.status, "failed");

    creator.disconnect();
    guest.disconnect();
  });

  it("replays translated rows in history and translates once per id", async () => {
    const creator = await connect();
    await callAck(creator, "room:create", {
      code: "TRF237",
      language: "fr",
      listeningLanguage: "fr",
    });
    const guest = await connect();
    await callAck(guest, "room:join", {
      code: "TRF237",
      language: "pa",
      listeningLanguage: "pa",
    });

    const callsBefore = translator.calls.filter(
      (call) => call.text === "Comment vas-tu?",
    ).length;
    const translated = onceEvent(guest, "conversation:translation");
    creator.emit("conversation:utterance", {
      utteranceId: "utt-flow-fr-03",
      text: "Comment vas-tu?",
      language: "fr",
    });
    await translated;
    // A replayed id is refused and never re-translated.
    const refused = onceEvent(creator, "error");
    creator.emit("conversation:utterance", {
      utteranceId: "utt-flow-fr-03",
      text: "Comment vas-tu?",
      language: "fr",
    });
    await refused;
    assert.equal(
      translator.calls.filter((call) => call.text === "Comment vas-tu?").length,
      callsBefore + 1,
    );

    // A newcomer replays history carrying the completed translation.
    guest.disconnect();
    const latecomer = await connect();
    const history = onceEvent(latecomer, "conversation:history");
    const rejoined = await callAck(latecomer, "room:join", {
      code: "TRF237",
      language: "pa",
      listeningLanguage: "pa",
    });
    assert.equal(rejoined.ok, true, JSON.stringify(rejoined));
    const [{ entries }] = await history;
    const replayed = entries.find(
      (row) => row.utterance.id === "utt-flow-fr-03",
    );
    assert.ok(replayed);
    assert.equal(replayed.utterance.text, "Comment vas-tu?");
    assert.deepEqual(replayed.translation, {
      status: "complete",
      text: "ਤੁਸੀਂ ਕਿਵੇਂ ਹੋ?",
      targetLanguage: "pa",
    });

    creator.disconnect();
    latecomer.disconnect();
  });
});
