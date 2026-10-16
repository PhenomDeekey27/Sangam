import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Server, Socket } from "socket.io";
import { resolveSpeechEnv } from "../config/env.js";
import { RoomManager } from "../rooms/room-manager.js";
import { SpeechSessions } from "./speech-sessions.js";
import type {
  SpeechProvider,
  SpeechProviderError,
  SpeechProviderOpenOptions,
  SpeechProviderSession,
} from "./provider.js";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "../sockets/contract.js";

type AppServer = Server<ClientToServerEvents, ServerToClientEvents>;
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

interface ScriptedSession extends SpeechProviderSession {
  readonly emitInterim: (text: string) => void;
  readonly emitFinal: (text: string) => void;
  readonly emitError: (error: SpeechProviderError) => void;
  readonly isClosed: () => boolean;
}

/** A provider whose transcripts the test drives directly. */
function scriptedProvider() {
  const sessions: ScriptedSession[] = [];
  const provider: SpeechProvider = {
    id: "mock",
    streaming: true,
    interim: true,
    languages: ["en", "hi", "ta", "te"],
    open(options: SpeechProviderOpenOptions) {
      let closed = false;
      const session: ScriptedSession = {
        push: () => {},
        stop: () => {},
        close: () => {
          closed = true;
        },
        emitInterim: (text) => {
          if (!closed) options.onInterim(text);
        },
        emitFinal: (text) => {
          if (!closed) options.onFinal(text);
        },
        emitError: (error) => {
          if (!closed) options.onError(error);
        },
        isClosed: () => closed,
      };
      sessions.push(session);
      return session;
    },
  };
  return { provider, sessions };
}

interface Harness {
  readonly sessions: SpeechSessions;
  readonly roomEmitted: { channel: string; event: string; payload: unknown }[];
  readonly socketEmitted: { event: string; payload: unknown }[];
  readonly scripted: ReturnType<typeof scriptedProvider>;
  readonly socket: AppSocket;
}

/** Build one seated participant (`side a`) and a recording IO fake. */
function harness(maxSessionBytes = 12_000_000): Harness {
  const rooms = new RoomManager();
  rooms.createAndJoin("ABCD23", {
    socketId: "sock-1",
    language: "ta",
    displayName: "",
  });
  const roomEmitted: Harness["roomEmitted"] = [];
  const io = {
    to: (channel: string) => ({
      emit: (event: string, payload: unknown) =>
        roomEmitted.push({ channel, event, payload }),
    }),
  } as unknown as AppServer;
  const socketEmitted: Harness["socketEmitted"] = [];
  const scripted = scriptedProvider();
  const sessions = new SpeechSessions(
    io,
    rooms,
    resolveSpeechEnv({ provider: "mock", maxSessionBytes }),
    scripted.provider,
  );
  const socket = {
    id: "sock-1",
    emit: (event: string, payload: unknown) =>
      socketEmitted.push({ event, payload }),
    to: () => ({ emit: () => {} }),
  } as unknown as AppSocket;
  return { sessions, roomEmitted, socketEmitted, scripted, socket };
}

describe("SpeechSessions lifecycle and limits", () => {
  it("opens a session in the seat's language and reports it in the ack", () => {
    const h = harness();
    const result = h.sessions.start(h.socket, { language: "ta" });
    assert.deepEqual(result, { ok: true, language: "ta" });
    assert.equal(h.scripted.sessions.length, 1);
  });

  it("refuses a language that does not match the seat", () => {
    const h = harness();
    const result = h.sessions.start(h.socket, { language: "hi" });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "language_mismatch");
    assert.equal(h.scripted.sessions.length, 0);
  });

  it("refuses an unsupported audio format before opening", () => {
    const h = harness();
    const result = h.sessions.start(h.socket, {
      language: "ta",
      mimeType: "video/mp4",
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "invalid_payload");
  });

  it("rejects a socket that is not a seated member", () => {
    const h = harness();
    const outsider = {
      id: "nobody",
      emit: () => {},
      to: () => ({ emit: () => {} }),
    } as unknown as AppSocket;
    const result = h.sessions.start(outsider, { language: "ta" });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "not_in_room");
  });

  it("refuses a seat language the provider does not support", () => {
    const rooms = new RoomManager();
    rooms.createAndJoin("WXYZ23", {
      socketId: "sock-es",
      language: "es",
      displayName: "",
    });
    const io = { to: () => ({ emit: () => {} }) } as unknown as AppServer;
    const scripted = scriptedProvider();
    const sessions = new SpeechSessions(
      io,
      rooms,
      resolveSpeechEnv({ provider: "mock" }),
      scripted.provider,
    );
    const socket = {
      id: "sock-es",
      emit: () => {},
      to: () => ({ emit: () => {} }),
    } as unknown as AppSocket;
    // Spanish is a valid seat language but outside this provider's list.
    const result = sessions.start(socket, { language: "es" });
    assert.equal(result.ok, false);
    assert.equal(
      result.ok === false && result.error.code,
      "language_not_supported",
    );
    assert.equal(scripted.sessions.length, 0);
  });
});

describe("SpeechSessions transcripts", () => {
  it("drops a repeated final inside the dedup window", () => {
    const h = harness();
    h.sessions.start(h.socket, { language: "ta" });
    const session = h.scripted.sessions[0];
    session?.emitFinal("Vanakkam");
    session?.emitFinal("Vanakkam");

    const finals = h.roomEmitted.filter(
      (e) => e.event === "conversation:utterance",
    );
    assert.equal(finals.length, 1);
    const payload = finals[0]?.payload as {
      entry: {
        utterance: { text: string; language: string; sequence: number };
      };
    };
    assert.equal(payload.entry.utterance.text, "Vanakkam");
    assert.equal(payload.entry.utterance.language, "ta");
    assert.equal(payload.entry.utterance.sequence, 1);
  });

  it("clears the speaker's interim line when a final lands", () => {
    const h = harness();
    h.sessions.start(h.socket, { language: "ta" });
    const session = h.scripted.sessions[0];
    session?.emitInterim("Vana");
    session?.emitFinal("Vanakkam");

    const interims = h.socketEmitted.filter(
      (e) => e.event === "speech:interim",
    );
    assert.deepEqual(interims.at(-1)?.payload, { text: "", language: "ta" });
  });

  it("stops relaying after release", () => {
    const h = harness();
    h.sessions.start(h.socket, { language: "ta" });
    const session = h.scripted.sessions[0];
    h.sessions.release("sock-1");
    assert.equal(session?.isClosed(), true);
    session?.emitFinal("too late");
    assert.equal(
      h.roomEmitted.filter((e) => e.event === "conversation:utterance").length,
      0,
    );
  });

  it("fails the session when the audio ceiling is exceeded", () => {
    const h = harness(16);
    h.sessions.start(h.socket, { language: "ta" });
    h.sessions.push(h.socket, new Uint8Array(8));
    h.sessions.push(h.socket, new Uint8Array(32));

    const error = h.socketEmitted.find((e) => e.event === "speech:error");
    assert.equal((error?.payload as { code: string }).code, "audio_too_large");
    assert.equal(h.scripted.sessions[0]?.isClosed(), true);
  });

  it("ignores audio for a socket with no active session", () => {
    const h = harness();
    h.sessions.push(h.socket, new Uint8Array(8));
    assert.equal(h.roomEmitted.length, 0);
  });
});
