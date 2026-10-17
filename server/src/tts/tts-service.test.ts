import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Server } from "socket.io";
import { RoomManager } from "../rooms/room-manager.js";
import type { Room, RoomParticipant } from "../rooms/room-types.js";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "../sockets/contract.js";
import { MockTtsProvider, fakeWavBytes } from "./mock-tts-provider.js";
import { TtsService } from "./tts-service.js";

type AppServer = Server<ClientToServerEvents, ServerToClientEvents>;

interface Emitted {
  readonly to: string;
  readonly event: string;
  readonly args: unknown[];
}

/** Capture variadic emits (`payload` plus the binary audio argument). */
function stubIo(emitted: Emitted[]): AppServer {
  return {
    to: (socketId: string) => ({
      emit: (event: string, ...args: unknown[]) => {
        emitted.push({ to: socketId, event, args });
      },
    }),
  } as unknown as AppServer;
}

function flush(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Seat A (fr/fr) plus seat B (pa/pa); B is the listener for A's speech. */
function twoSeatRoom(
  rooms: RoomManager,
  code: string,
): { room: Room; listener: RoomParticipant } {
  const created = rooms.createAndJoin(code, {
    socketId: "socket-a",
    language: "fr",
    listeningLanguage: "fr",
    displayName: "",
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const joined = rooms.joinRoom(code, {
    socketId: "socket-b",
    language: "pa",
    listeningLanguage: "pa",
    displayName: "",
  });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  if (!joined.ok) throw new Error("unreachable");
  const listener = joined.room.participants.get("b");
  if (!listener) throw new Error("listener missing");
  return { room: joined.room, listener };
}

function playbackArgs(args: unknown[]): {
  payload: Record<string, unknown>;
  audio: ArrayBuffer;
} {
  const [payload, audio] = args;
  return {
    payload: payload as Record<string, unknown>,
    audio: audio as ArrayBuffer,
  };
}

/** Byte-equality against the fake WAV, tolerant of ArrayBuffer views. */
function assertAudioEquals(actual: ArrayBuffer, expected: Buffer): void {
  assert.ok(
    Buffer.from(actual).equals(expected),
    "delivered audio bytes differ from the scripted WAV",
  );
}

const TRANSLATION = { text: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ", targetLanguage: "pa" };

describe("TtsService", () => {
  it("delivers one synthesized WAV to the listener only, ordered by sequence", async () => {
    const rooms = new RoomManager();
    const emitted: Emitted[] = [];
    const { room, listener } = twoSeatRoom(rooms, "TTS234");
    const provider = new MockTtsProvider();
    const service = new TtsService(stubIo(emitted), rooms, provider);

    service.speakForListener(room, listener, "utt-a-1", TRANSLATION);
    await flush();

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.to, "socket-b");
    assert.equal(emitted[0]?.event, "conversation:playback");
    const { payload, audio } = playbackArgs(emitted[0]?.args ?? []);
    assert.equal(payload.utteranceId, "utt-a-1");
    assert.equal(payload.language, "pa");
    assert.equal(payload.mimeType, "audio/wav");
    assert.equal(payload.sequence, 0); // row not retained here
    assertAudioEquals(audio, fakeWavBytes(TRANSLATION.text));
  });

  it("reports the stored row's sequence in the payload", async () => {
    const rooms = new RoomManager();
    const emitted: Emitted[] = [];
    const { room, listener } = twoSeatRoom(rooms, "TTS235");
    rooms.recordUtterance(room, {
      utterance: {
        id: "utt-a-2",
        speakerSide: "a",
        language: "fr",
        text: "Bonjour",
        finalizedAt: Date.now(),
        sequence: 7,
      },
      translation: { status: "complete", ...TRANSLATION },
    });
    const service = new TtsService(stubIo(emitted), rooms, new MockTtsProvider());

    service.speakForListener(room, listener, "utt-a-2", TRANSLATION);
    await flush();

    const { payload } = playbackArgs(emitted[0]?.args ?? []);
    assert.equal(payload.sequence, 7);
  });

  it("never emits twice for the same utterance id, even while in flight", async () => {
    const rooms = new RoomManager();
    const emitted: Emitted[] = [];
    const { room, listener } = twoSeatRoom(rooms, "TTS236");
    const provider = new MockTtsProvider({ deferred: true });
    const service = new TtsService(stubIo(emitted), rooms, provider);

    service.speakForListener(room, listener, "utt-a-3", TRANSLATION);
    // A racing duplicate (replay/re-translated row) must be a no-op.
    service.speakForListener(room, listener, "utt-a-3", TRANSLATION);
    provider.release();
    await flush();
    provider.release();
    await flush();

    assert.equal(provider.calls.length, 1);
    assert.equal(emitted.length, 1);
  });

  it("drops the delivery when the listener left during synthesis", async () => {
    const rooms = new RoomManager();
    const emitted: Emitted[] = [];
    const { room, listener } = twoSeatRoom(rooms, "TTS237");
    const provider = new MockTtsProvider({ deferred: true });
    const service = new TtsService(stubIo(emitted), rooms, provider);

    service.speakForListener(room, listener, "utt-a-4", TRANSLATION);
    rooms.removeBySocket(listener.socketId);
    provider.release();
    await flush();

    assert.equal(emitted.length, 0);
    // Still claimed: a repeat cannot resurrect the delivery for a gone seat.
    assert.equal(provider.calls.length, 1);
  });

  it("refuses an unsupported target language without calling the provider", async () => {
    const rooms = new RoomManager();
    const emitted: Emitted[] = [];
    const { room, listener } = twoSeatRoom(rooms, "TTS238");
    const provider = new MockTtsProvider();
    const service = new TtsService(stubIo(emitted), rooms, provider);

    service.speakForListener(
      room,
      listener,
      "utt-a-5",
      { text: "hola", targetLanguage: "xx" },
    );
    await flush();

    assert.equal(provider.calls.length, 0);
    assert.equal(emitted.length, 0);
  });

  it("keeps the translated text usable when the provider fails", async () => {
    const rooms = new RoomManager();
    const emitted: Emitted[] = [];
    const { room, listener } = twoSeatRoom(rooms, "TTS239");
    const provider = new MockTtsProvider({ failures: { pa: "rate_limited" } });
    const service = new TtsService(stubIo(emitted), rooms, provider);

    await assert.doesNotReject(() =>
      Promise.resolve(
        service.speakForListener(room, listener, "utt-a-6", TRANSLATION),
      ),
    );
    await flush();

    assert.equal(provider.calls.length, 1);
    assert.equal(emitted.length, 0);
    // The row's translation state is untouched by playback — it lives on the
    // transcript and has already been emitted by the translation service.
    const stored = room.transcript.find((row) => row.utterance.id === "utt-a-6");
    assert.equal(stored, undefined);
  });

  it("drops oversized audio without delivery", async () => {
    const rooms = new RoomManager();
    const emitted: Emitted[] = [];
    const { room, listener } = twoSeatRoom(rooms, "TTS759");
    const service = new TtsService(
      stubIo(emitted),
      rooms,
      new MockTtsProvider(),
      { maxAudioBytes: 10 },
    );

    service.speakForListener(room, listener, "utt-a-7", TRANSLATION);
    await flush();

    assert.equal(emitted.length, 0);
  });

  it("a null provider is a no-op for every invocation", () => {
    const rooms = new RoomManager();
    const emitted: Emitted[] = [];
    const { room, listener } = twoSeatRoom(rooms, "TTS758");
    const service = new TtsService(stubIo(emitted), rooms, null);

    service.speakForListener(room, listener, "utt-a-8", TRANSLATION);
    assert.equal(emitted.length, 0);
  });
});
