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

/**
 * Mirrored-pair fallback: rooms from the invite flow hold crossed pairs
 * (a:en/ta, b:ta/en), where the listener's listening language always equals
 * the incoming source. The service must fall back to the language the
 * listener speaks instead of skipping every utterance — while a room where
 * both seats genuinely share one language still skips with no billed call.
 */

type AppServer = Server<ClientToServerEvents, ServerToClientEvents>;

function stubIo(emitted: Array<{ event: string; payload: unknown }>) {
  return {
    to: () => ({
      emit: (event: string, payload: unknown) => {
        emitted.push({ event, payload });
      },
    }),
  } as unknown as AppServer;
}

function flush(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function row(
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

function mirroredRoom(rooms: RoomManager, code: string): Room {
  const created = rooms.createAndJoin(code, {
    socketId: `socket-a-${code}`,
    language: "en",
    listeningLanguage: "ta",
    displayName: "",
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  if (!created.ok) throw new Error("unreachable");
  const joined = rooms.joinRoom(code, {
    socketId: `socket-b-${code}`,
    language: "ta",
    listeningLanguage: "en",
    displayName: "",
  });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  if (!joined.ok) throw new Error("unreachable");
  return joined.room;
}

describe("TranslationService mirrored-pair fallback", () => {
  it("translates both directions in a mirrored en/ta room", async () => {
    const rooms = new RoomManager();
    const room = mirroredRoom(rooms, "TRN244");
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const translator = new MockTranslator({
      canned: {
        ta: { en: { "வணக்கம்": "Hello" } },
        en: { ta: { Hello: "வணக்கம்" } },
      },
    });
    const service = new TranslationService(stubIo(emitted), rooms, translator);

    const taRow = row("utt-ta-0001", "b", "ta", "வணக்கம்", 1);
    rooms.recordUtterance(room, taRow);
    service.translateUtterance(room, taRow);
    await flush();
    assert.deepEqual(translator.calls, [
      { text: "வணக்கம்", sourceLanguage: "ta", targetLanguage: "en" },
    ]);
    assert.deepEqual(taRow.translation, {
      status: "complete",
      text: "Hello",
      targetLanguage: "en",
    });

    const enRow = row("utt-en-0001", "a", "en", "Hello", 2);
    rooms.recordUtterance(room, enRow);
    service.translateUtterance(room, enRow);
    await flush();
    assert.deepEqual(translator.calls[1], {
      text: "Hello",
      sourceLanguage: "en",
      targetLanguage: "ta",
    });
    assert.deepEqual(enRow.translation, {
      status: "complete",
      text: "வணக்கம்",
      targetLanguage: "ta",
    });
    assert.equal(
      emitted.filter((item) => item.event === "conversation:translation").length,
      2,
    );
  });

  it("still skips when both seats genuinely share one language", async () => {
    const rooms = new RoomManager();
    const created = rooms.createAndJoin("TRN245", {
      socketId: "socket-a",
      language: "ta",
      listeningLanguage: "ta",
      displayName: "",
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    if (!created.ok) throw new Error("unreachable");
    const joined = rooms.joinRoom("TRN245", {
      socketId: "socket-b",
      language: "ta",
      listeningLanguage: "ta",
      displayName: "",
    });
    assert.equal(joined.ok, true, JSON.stringify(joined));
    if (!joined.ok) throw new Error("unreachable");

    const emitted: Array<{ event: string; payload: unknown }> = [];
    const translator = new MockTranslator({
      canned: { ta: { en: { "வணக்கம்": "Hello" } } },
    });
    const service = new TranslationService(stubIo(emitted), rooms, translator);
    const taRow = row("utt-ta-0002", "a", "ta", "வணக்கம்", 1);
    rooms.recordUtterance(joined.room, taRow);
    service.translateUtterance(joined.room, taRow);
    await flush();
    assert.equal(translator.calls.length, 0);
    assert.equal(taRow.translation.status, "unavailable");
    assert.equal(emitted.length, 0);
  });
});
