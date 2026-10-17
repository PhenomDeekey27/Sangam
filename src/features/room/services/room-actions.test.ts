import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  createRoomActions,
  emitRoomJoin,
  type RoomJoinEffects,
  type RoomActionContext,
} from "@/features/room/services/room-actions";
import {
  destroyRoomSocket,
  getRoomSocket,
} from "@/features/room/services/socket";
import type { RoomSocket } from "@/features/room/services/socket";
import type { RoomOpAck } from "@/types/socket";

interface Emitted {
  readonly event: string;
  readonly payload: unknown;
  readonly ack: (response: RoomOpAck) => void;
}

function fakeSocket(emitted: Emitted[]): RoomSocket {
  return {
    emit: (
      event: string,
      payload: unknown,
      ack?: (response: RoomOpAck) => void,
    ) => {
      emitted.push({ event, payload, ack: ack ?? (() => {}) });
      return true;
    },
  } as unknown as RoomSocket;
}

function effects(log: string[]): RoomJoinEffects {
  return {
    notify: (message) => log.push(`notify:${message ?? "(none)"}`),
    silence: () => log.push("silence"),
    onRoomError: (error) => log.push(`room-error:${error.code}`),
    onJoined: (self, created) =>
      log.push(`joined:${self.side}:${created ? "created" : "joined"}`),
  };
}

function ack(emitted: Emitted[], index: number, response: RoomOpAck): void {
  const target = emitted[index];
  assert.ok(target, `expected emit #${index}`);
  target.ack(response);
}

describe("emitRoomJoin", () => {
  it("sends both language preferences on create", () => {
    const emitted: Emitted[] = [];
    emitRoomJoin(
      fakeSocket(emitted),
      "create",
      { code: "VWX999", language: "ta", listeningLanguage: "te" },
      effects([]),
    );
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.event, "room:create");
    assert.deepEqual(emitted[0]?.payload, {
      code: "VWX999",
      language: "ta",
      listeningLanguage: "te",
    });
  });

  it("reports the assigned seat on success", () => {
    const emitted: Emitted[] = [];
    const log: string[] = [];
    emitRoomJoin(
      fakeSocket(emitted),
      "join",
      { code: "VWX999", language: "te", listeningLanguage: "ta" },
      effects(log),
    );
    ack(emitted, 0, { ok: true, self: { id: "p1", side: "b" } });
    assert.deepEqual(log, ["joined:b:joined"]);
  });

  it("falls back to join when the room already exists", () => {
    const emitted: Emitted[] = [];
    const log: string[] = [];
    emitRoomJoin(
      fakeSocket(emitted),
      "create",
      { code: "VWX999", language: "te", listeningLanguage: "ta" },
      effects(log),
    );
    ack(emitted, 0, {
      ok: false,
      error: { code: "room_already_exists", message: "taken" },
    });
    assert.equal(emitted.length, 2);
    assert.equal(emitted[1]?.event, "room:join");
    assert.deepEqual(emitted[1]?.payload, {
      code: "VWX999",
      language: "te",
      listeningLanguage: "ta",
    });
    ack(emitted, 1, { ok: true, self: { id: "p2", side: "b" } });
    assert.deepEqual(log, ["joined:b:joined"]);
  });

  it("reports a membership failure without joining", () => {
    const emitted: Emitted[] = [];
    const log: string[] = [];
    emitRoomJoin(
      fakeSocket(emitted),
      "join",
      { code: "VWX999", language: "en", listeningLanguage: "en" },
      effects(log),
    );
    ack(emitted, 0, {
      ok: false,
      error: { code: "room_not_found", message: "missing" },
    });
    assert.deepEqual(log, ["room-error:room_not_found", "silence"]);
    assert.equal(emitted.length, 1);
  });

  it("times out when the server never answers the join", async () => {
    const emitted: Emitted[] = [];
    const log: string[] = [];
    emitRoomJoin(
      fakeSocket(emitted),
      "join",
      { code: "VWX999", language: "pa", listeningLanguage: "fr" },
      {
        ...effects(log),
        onTimeout: () => log.push("timeout"),
      },
      { timeoutMs: 20 },
    );
    // No ack arrives (backend died mid-join): the deadline fires instead of
    // hanging on "connecting" forever. Preferences ride along regardless.
    assert.deepEqual(emitted[0]?.payload, {
      code: "VWX999",
      language: "pa",
      listeningLanguage: "fr",
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(log, ["timeout"]);
  });

  it("ignores a late ack after the join timed out", async () => {
    const emitted: Emitted[] = [];
    const log: string[] = [];
    emitRoomJoin(
      fakeSocket(emitted),
      "join",
      { code: "VWX999", language: "pa", listeningLanguage: "fr" },
      {
        ...effects(log),
        onTimeout: () => log.push("timeout"),
      },
      { timeoutMs: 20 },
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    ack(emitted, 0, { ok: true, self: { id: "p1", side: "b" } });
    // The stale success must not flip the UI to joined after the timeout
    // already moved it to the retry path.
    assert.deepEqual(log, ["timeout"]);
  });

  it("never times out a join the server answers in time", async () => {
    const emitted: Emitted[] = [];
    const log: string[] = [];
    emitRoomJoin(
      fakeSocket(emitted),
      "join",
      { code: "VWX999", language: "pa", listeningLanguage: "fr" },
      {
        ...effects(log),
        onTimeout: () => log.push("timeout"),
      },
      { timeoutMs: 1000 },
    );
    ack(emitted, 0, { ok: true, self: { id: "p1", side: "b" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(log, ["joined:b:joined"]);
  });
});

interface RecordingForActions {
  readonly notes: (string | null)[];
  readonly requested: string[];
  readonly acks: { readonly ok: boolean }[];
}

function recordingForActions(): RecordingForActions {
  return { notes: [], requested: [], acks: [] };
}

function contextForActions(
  selfId: string | null,
  rec: RecordingForActions,
): RoomActionContext {
  return {
    language: "en",
    selfId,
    partnerPresent: true,
    notify: (message) => rec.notes.push(message),
  };
}

describe("createRoomActions.interrupt guards", () => {
  afterEach(() => {
    // The singleton was created lazily in the guard paths; drop it so the
    // suite never shares a socket across tests.
    destroyRoomSocket();
  });

  it("does nothing when this client is not seated yet", () => {
    const rec = recordingForActions();
    const actions = createRoomActions(contextForActions(null, rec));
    actions.interrupt({
      onRequested: (id) => rec.requested.push(id),
      onAck: (response) => rec.acks.push({ ok: response.ok }),
    });
    assert.equal(rec.notes.length, 0);
    assert.equal(rec.requested.length, 0);
    assert.equal(rec.acks.length, 0);
  });

  it("does nothing while the singleton socket is not connected", () => {
    const rec = recordingForActions();
    assert.equal(getRoomSocket().connected, false);
    const actions = createRoomActions(contextForActions("p1", rec));
    actions.interrupt({
      onRequested: (id) => rec.requested.push(id),
      onAck: (response) => rec.acks.push({ ok: response.ok }),
    });
    assert.equal(rec.notes.length, 0);
    assert.equal(rec.requested.length, 0);
    assert.equal(rec.acks.length, 0);
  });
});
