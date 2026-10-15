import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EMPTY_ROOM_TTL_MS, RoomManager, statusOf } from "./room-manager.js";

function joiner(socketId: string) {
  return { socketId, language: "en", displayName: "" };
}

function expectOk<T extends { ok: boolean }>(
  result: T,
): Extract<T, { ok: true }> {
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

function expectError(
  result: { ok: true } | { ok: false; error: { code: string } },
  code: string,
): void {
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, code);
}

describe("room creation", () => {
  it("reserves an empty room with a normalized code", () => {
    const rooms = new RoomManager();
    const created = expectOk(rooms.createRoom(" abc234 "));
    assert.equal(created.room.code, "ABC234");
    assert.equal(rooms.roomCount, 1);
    assert.equal(created.room.participants.size, 0);
  });

  it("refuses to reserve an existing code", () => {
    const rooms = new RoomManager();
    expectOk(rooms.createRoom("ABC234"));
    expectError(rooms.createRoom("ABC234"), "room_already_exists");
  });

  it("refuses malformed codes", () => {
    const rooms = new RoomManager();
    expectError(rooms.createRoom("SHORT"), "invalid_code");
    expectError(rooms.createRoom("ABC1IL"), "invalid_code");
    expectError(rooms.createRoom(42 as never), "invalid_code");
  });
});

describe("side assignment", () => {
  it("seats the creator as side a", () => {
    const rooms = new RoomManager();
    const joined = expectOk(rooms.createAndJoin("ABC234", joiner("socket-1")));
    assert.equal(joined.participant.side, "a");
    assert.equal(joined.created, true);
    assert.equal(joined.participant.displayName, "Speaker A");
  });

  it("seats the second participant as side b", () => {
    const rooms = new RoomManager();
    expectOk(rooms.createAndJoin("ABC234", joiner("socket-1")));
    const second = expectOk(rooms.joinRoom("ABC234", joiner("socket-2")));
    assert.equal(second.participant.side, "b");
    assert.equal(second.participant.displayName, "Speaker B");
    assert.equal(statusOf(second.room), "live");
  });

  it("rejects a third participant", () => {
    const rooms = new RoomManager();
    expectOk(rooms.createAndJoin("ABC234", joiner("socket-1")));
    expectOk(rooms.joinRoom("ABC234", joiner("socket-2")));
    expectError(rooms.joinRoom("ABC234", joiner("socket-3")), "room_full");
    assert.equal(rooms.roomCount, 1);
  });

  it("rejects unknown and malformed codes on join", () => {
    const rooms = new RoomManager();
    expectError(rooms.joinRoom("ZZZ999", joiner("s1")), "room_not_found");
    expectError(rooms.joinRoom("nope", joiner("s1")), "invalid_code");
  });

  it("treats a duplicate join from the same socket as idempotent", () => {
    const rooms = new RoomManager();
    const first = expectOk(rooms.createAndJoin("ABC234", joiner("socket-1")));
    const again = expectOk(rooms.joinRoom("ABC234", joiner("socket-1")));
    assert.equal(again.participant.id, first.participant.id);
    assert.equal(again.room.participants.size, 1);
  });

  it("moves a socket that joins a different room", () => {
    const rooms = new RoomManager();
    expectOk(rooms.createAndJoin("ABC234", joiner("socket-1")));
    expectOk(rooms.createRoom("QRS234"));
    const moved = expectOk(rooms.joinRoom("QRS234", joiner("socket-1")));
    assert.equal(moved.room.code, "QRS234");
    assert.equal(rooms.roomByCode("ABC234")?.participants.size, 0);
  });
});

describe("leaving and presence", () => {
  it("removes membership and reports who remains", () => {
    const rooms = new RoomManager();
    expectOk(rooms.createAndJoin("ABC234", joiner("socket-1")));
    const second = expectOk(rooms.joinRoom("ABC234", joiner("socket-2")));

    const departure = rooms.removeBySocket(second.participant.socketId);
    assert.ok(departure);
    assert.equal(departure.participant.side, "b");
    assert.equal(departure.remaining.length, 1);
    assert.equal(departure.remaining[0]?.side, "a");
    assert.equal(departure.roomEmpty, false);
    assert.equal(rooms.membershipOf("socket-2"), null);
    assert.equal(statusOf(rooms.roomByCode("ABC234")!), "waiting");
  });

  it("marks the room empty when the last participant leaves", () => {
    const rooms = new RoomManager();
    const first = expectOk(rooms.createAndJoin("ABC234", joiner("socket-1")));
    const departure = rooms.removeBySocket(first.participant.socketId);
    assert.equal(departure?.roomEmpty, true);
    assert.equal(rooms.roomByCode("ABC234")?.emptySince !== null, true);
  });

  it("returns null when removing an unknown socket", () => {
    const rooms = new RoomManager();
    assert.equal(rooms.removeBySocket("ghost"), null);
  });
});

describe("empty-room expiry", () => {
  it("sweeps a room only once it has been empty for the full TTL", () => {
    const rooms = new RoomManager();
    const created = expectOk(rooms.createRoom("ABC234"));
    const ttlAt = created.room.emptySince! + EMPTY_ROOM_TTL_MS;

    assert.deepEqual(rooms.sweepEmptyRooms(ttlAt - 1), []);
    assert.equal(rooms.roomCount, 1);
    assert.deepEqual(rooms.sweepEmptyRooms(ttlAt), ["ABC234"]);
    assert.equal(rooms.roomCount, 0);
  });

  it("keeps an empty room that is re-claimed before the sweep", () => {
    const rooms = new RoomManager();
    const first = expectOk(rooms.createAndJoin("ABC234", joiner("socket-1")));
    rooms.removeBySocket(first.participant.socketId);
    const rejoined = expectOk(rooms.joinRoom("ABC234", joiner("socket-1")));
    assert.equal(rejoined.room.participants.size, 1);

    assert.deepEqual(
      rooms.sweepEmptyRooms(Date.now() + 10 * EMPTY_ROOM_TTL_MS),
      [],
    );
    assert.equal(rooms.roomCount, 1);
  });

  it("keeps an occupied room regardless of emptySince", () => {
    const rooms = new RoomManager();
    expectOk(rooms.createAndJoin("ABC234", joiner("socket-1")));
    assert.deepEqual(
      rooms.sweepEmptyRooms(Date.now() + 10 * EMPTY_ROOM_TTL_MS),
      [],
    );
    assert.equal(rooms.roomCount, 1);
  });
});

describe("snapshots", () => {
  it("exposes only server-known participant fields", () => {
    const rooms = new RoomManager();
    expectOk(rooms.createAndJoin("ABC234", joiner("socket-1")));
    const second = expectOk(
      rooms.joinRoom("ABC234", { ...joiner("socket-2"), displayName: "Maya" }),
    );
    const snapshot = rooms.snapshot(second.room);
    assert.equal(snapshot.code, "ABC234");
    assert.equal(snapshot.status, "live");
    assert.deepEqual(
      snapshot.participants.map((p) => [p.side, p.displayName, p.status]),
      [
        ["a", "Speaker A", "connected"],
        ["b", "Maya", "connected"],
      ],
    );
  });
});
