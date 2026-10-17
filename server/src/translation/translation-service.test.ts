import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Server } from "socket.io";
import { RoomManager } from "../rooms/room-manager.js";
import type { Room, RoomTranscriptEntry } from "../rooms/room-types.js";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "../sockets/contract.js";
import { MockTranslator } from "./mock-translator.js";
import { TranslationService } from "./translation-service.js";

type AppServer = Server<ClientToServerEvents, ServerToClientEvents>;

interface Emitted {
  readonly to: string;
  readonly event: string;
  readonly payload: unknown;
}

function stubIo(emitted: Emitted[]): AppServer {
  return {
    to: (socketId: string) => ({
      emit: (event: string, payload: unknown) => {
        emitted.push({ to: socketId, event, payload });
      },
    }),
  } as unknown as AppServer;
}

function flush(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Seat A (fr/fr) plus seat B (pa/pa); returns room and socket ids. */
function twoSeatRoom(
  rooms: RoomManager,
  code: string,
): {
  room: Room;
  socketA: string;
  socketB: string;
} {
  const created = rooms.createAndJoin(code, {
    socketId: "socket-a",
    language: "fr",
    listeningLanguage: "fr",
    displayName: "",
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  if (!created.ok) throw new Error("unreachable");
  const joined = rooms.joinRoom(code, {
    socketId: "socket-b",
    language: "pa",
    listeningLanguage: "pa",
    displayName: "",
  });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  if (!joined.ok) throw new Error("unreachable");
  return { room: joined.room, socketA: "socket-a", socketB: "socket-b" };
}

function entry(
  id: string,
  speakerSide: "a" | "b",
  language: string,
  text: string,
  sequence: number,
): RoomTranscriptEntry {
  return {
    utterance: {
      id,
      speakerSide,
      language,
      text,
      finalizedAt: Date.now(),
      sequence,
    },
    translation: { status: "unavailable" },
  };
}

describe("TranslationService", () => {
  it("translates into the listener's stored language, not the speaker's", async () => {
    const rooms = new RoomManager();
    const emitted: Emitted[] = [];
    const { room, socketB } = twoSeatRoom(rooms, "TRN234");
    const translator = new MockTranslator({
      canned: { fr: { pa: { Bonjour: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ" } } },
    });
    const service = new TranslationService(stubIo(emitted), rooms, translator);

    const row = entry("utt-fr-0001", "a", "fr", "Bonjour", 1);
    rooms.recordUtterance(room, row);
    service.translateUtterance(room, row);
    await flush();

    // The recipient is seat B (pa/pa): target is B's listening language.
    assert.deepEqual(translator.calls, [
      { text: "Bonjour", sourceLanguage: "fr", targetLanguage: "pa" },
    ]);
    assert.equal(row.translation.status, "complete");
    assert.deepEqual(row.translation, {
      status: "complete",
      text: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ",
      targetLanguage: "pa",
    });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.to, socketB);
    assert.equal(emitted[0]?.event, "conversation:translation");
    assert.deepEqual(emitted[0]?.payload, {
      utteranceId: "utt-fr-0001",
      translation: row.translation,
    });

    // Neither seat's stored preferences moved.
    const snapshot = rooms.snapshot(room);
    assert.deepEqual(
      snapshot.participants.map((p) => [
        p.side,
        p.language,
        p.listeningLanguage,
      ]),
      [
        ["a", "fr", "fr"],
        ["b", "pa", "pa"],
      ],
    );
  });

  it("translates the reverse direction for the other seat", async () => {
    const rooms = new RoomManager();
    const emitted: Emitted[] = [];
    const { room, socketA } = twoSeatRoom(rooms, "TRN235");
    const translator = new MockTranslator({
      canned: { pa: { fr: { "ਸਤ ਸ੍ਰੀ ਅਕਾਲ": "Bonjour" } } },
    });
    const service = new TranslationService(stubIo(emitted), rooms, translator);

    const row = entry("utt-pa-0001", "b", "pa", "ਸਤ ਸ੍ਰੀ ਅਕਾਲ", 1);
    rooms.recordUtterance(room, row);
    service.translateUtterance(room, row);
    await flush();

    assert.deepEqual(translator.calls, [
      { text: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ", sourceLanguage: "pa", targetLanguage: "fr" },
    ]);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.to, socketA);
    assert.deepEqual(
      (emitted[0]?.payload as { translation: unknown }).translation,
      {
        status: "complete",
        text: "Bonjour",
        targetLanguage: "fr",
      },
    );
  });

  it("skips translation with no listener or identical languages", async () => {
    const rooms = new RoomManager();
    const emitted: Emitted[] = [];
    const created = rooms.createAndJoin("TRN236", {
      socketId: "socket-a",
      language: "fr",
      listeningLanguage: "pa",
      displayName: "",
    });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("unreachable");
    const translator = new MockTranslator({
      canned: { fr: { pa: { Bonjour: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ" } } },
    });
    const service = new TranslationService(stubIo(emitted), rooms, translator);

    // Speaker alone: nobody to translate for.
    const lonely = entry("utt-fr-0002", "a", "fr", "Bonjour", 1);
    rooms.recordUtterance(created.room, lonely);
    service.translateUtterance(created.room, lonely);
    await flush();
    assert.equal(translator.calls.length, 0);
    assert.equal(lonely.translation.status, "unavailable");

    // Same language both sides: nothing to translate, no billed call.
    rooms.joinRoom("TRN236", {
      socketId: "socket-b",
      language: "fr",
      listeningLanguage: "fr",
      displayName: "",
    });
    const same = entry("utt-fr-0003", "a", "fr", "Bonjour", 2);
    rooms.recordUtterance(created.room, same);
    service.translateUtterance(created.room, same);
    await flush();
    assert.equal(translator.calls.length, 0);
    assert.equal(same.translation.status, "unavailable");
    assert.equal(emitted.length, 0);
  });

  it("marks failure safely and keeps the original visible", async () => {
    const rooms = new RoomManager();
    const emitted: Emitted[] = [];
    const { room } = twoSeatRoom(rooms, "TRN237");
    const translator = new MockTranslator({
      failures: { fr: { pa: { Bonjour: "rate_limited" } } },
    });
    const service = new TranslationService(stubIo(emitted), rooms, translator);

    const row = entry("utt-fr-0004", "a", "fr", "Bonjour", 1);
    rooms.recordUtterance(room, row);
    service.translateUtterance(room, row);
    await flush();

    assert.equal(row.utterance.text, "Bonjour");
    assert.deepEqual(row.translation, {
      status: "failed",
      error: {
        code: "provider_error",
        message: "Translation failed — showing the original.",
      },
    });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.event, "conversation:translation");
  });

  it("translates each utterance once and resolves out-of-order by id", async () => {
    const rooms = new RoomManager();
    const emitted: Emitted[] = [];
    const { room } = twoSeatRoom(rooms, "TRN238");
    const translator = new MockTranslator({
      deferred: true,
      canned: {
        fr: { pa: { premier: "ਪਹਿਲਾ", second: "ਦੂਜਾ" } },
      },
    });
    const service = new TranslationService(stubIo(emitted), rooms, translator);

    const first = entry("utt-fr-0005", "a", "fr", "premier", 1);
    const second = entry("utt-fr-0006", "a", "fr", "second", 2);
    rooms.recordUtterance(room, first);
    rooms.recordUtterance(room, second);
    service.translateUtterance(room, first);
    service.translateUtterance(room, first); // duplicate work refused
    service.translateUtterance(room, second);
    translator.release();
    await flush();

    assert.equal(
      translator.calls.filter((call) => call.text === "premier").length,
      1,
    );
    assert.deepEqual(first.translation, {
      status: "complete",
      text: "ਪਹਿਲਾ",
      targetLanguage: "pa",
    });
    assert.deepEqual(second.translation, {
      status: "complete",
      text: "ਦੂਜਾ",
      targetLanguage: "pa",
    });
    // One update per utterance id, each carrying its own row's text.
    const updates = emitted.filter(
      (item) => item.event === "conversation:translation",
    );
    assert.equal(updates.length, 2);
    const byId = new Map(
      updates.map((item) => [
        (item.payload as { utteranceId: string }).utteranceId,
        (item.payload as { translation: { text: string } }).translation.text,
      ]),
    );
    assert.equal(byId.get("utt-fr-0005"), "ਪਹਿਲਾ");
    assert.equal(byId.get("utt-fr-0006"), "ਦੂਜਾ");
  });

  it("persists history without emitting when the listener left mid-translation", async () => {
    const rooms = new RoomManager();
    const emitted: Emitted[] = [];
    const { room, socketB } = twoSeatRoom(rooms, "TRN239");
    const translator = new MockTranslator({
      deferred: true,
      canned: { fr: { pa: { Bonjour: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ" } } },
    });
    const service = new TranslationService(stubIo(emitted), rooms, translator);

    const row = entry("utt-fr-0007", "a", "fr", "Bonjour", 1);
    rooms.recordUtterance(room, row);
    service.translateUtterance(room, row);
    rooms.removeBySocket(socketB);
    translator.release();
    await flush();

    // No crash, no emit to a gone socket — but the history row keeps it.
    assert.equal(emitted.length, 0);
    assert.deepEqual(row.translation, {
      status: "complete",
      text: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ",
      targetLanguage: "pa",
    });
    assert.deepEqual(rooms.transcriptOf(room)[0]?.translation, row.translation);
  });

  it("does nothing when translation is unconfigured", async () => {
    const rooms = new RoomManager();
    const emitted: Emitted[] = [];
    const { room } = twoSeatRoom(rooms, "TRN242");
    const service = new TranslationService(stubIo(emitted), rooms, null);
    const row = entry("utt-fr-0008", "a", "fr", "Bonjour", 1);
    rooms.recordUtterance(room, row);
    service.translateUtterance(room, row);
    await flush();
    assert.equal(row.translation.status, "unavailable");
    assert.equal(emitted.length, 0);
  });

  it("preserves the timeout category instead of collapsing it to unknown", async () => {
    const rooms = new RoomManager();
    const emitted: Emitted[] = [];
    const { room } = twoSeatRoom(rooms, "TRN243");
    const translator = new MockTranslator({
      failures: { fr: { pa: { Bonjour: "timeout" } } },
    });
    const service = new TranslationService(stubIo(emitted), rooms, translator);

    const row = entry("utt-fr-0009", "a", "fr", "Bonjour", 1);
    rooms.recordUtterance(room, row);
    service.translateUtterance(room, row);
    await flush();

    assert.equal(row.utterance.text, "Bonjour");
    assert.deepEqual(row.translation, {
      status: "failed",
      error: {
        code: "timeout",
        message:
          "Translation timed out — showing the original. Keep talking; the next line will retry.",
      },
    });
    assert.equal(emitted.length, 1);
  });
});
