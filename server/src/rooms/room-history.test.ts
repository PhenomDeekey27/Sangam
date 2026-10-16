import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EMPTY_ROOM_TTL_MS,
  MAX_TRANSCRIPT_ENTRIES,
  RoomManager,
} from "./room-manager.js";
import type { RoomTranscriptEntry } from "./room-types.js";

function joiner(socketId: string) {
  return { socketId, language: "en", displayName: "" };
}

function expectOk<T extends { ok: boolean }>(
  result: T,
): Extract<T, { ok: true }> {
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

function entry(
  sequence: number,
  overrides: Partial<RoomTranscriptEntry["utterance"]> = {},
): RoomTranscriptEntry {
  return {
    utterance: {
      id: `utt-${sequence}`,
      speakerSide: sequence % 2 === 0 ? "b" : "a",
      language: "hi",
      text: `line ${sequence}`,
      finalizedAt: 1_700_000_000_000 + sequence,
      sequence,
      ...overrides,
    },
    translation: { status: "unavailable" },
  };
}

describe("room transcript history", () => {
  it("retains finalized rows in order with their original metadata", () => {
    const rooms = new RoomManager();
    const { room } = expectOk(rooms.createAndJoin("ABC234", joiner("s1")));
    rooms.recordUtterance(room, entry(1));
    rooms.recordUtterance(room, entry(2, { speakerSide: "b", language: "ta" }));

    const history = rooms.transcriptOf(room);
    assert.equal(history.length, 2);
    assert.deepEqual(
      history.map((row) => [
        row.utterance.id,
        row.utterance.speakerSide,
        row.utterance.language,
        row.utterance.sequence,
        row.translation.status,
      ]),
      [
        ["utt-1", "a", "hi", 1, "unavailable"],
        ["utt-2", "b", "ta", 2, "unavailable"],
      ],
    );
  });

  it("drops the oldest rows once the retention cap is reached", () => {
    const rooms = new RoomManager();
    const { room } = expectOk(rooms.createAndJoin("ABC235", joiner("s1")));
    for (let i = 1; i <= MAX_TRANSCRIPT_ENTRIES + 5; i += 1) {
      rooms.recordUtterance(room, entry(i));
    }
    const history = rooms.transcriptOf(room);
    assert.equal(history.length, MAX_TRANSCRIPT_ENTRIES);
    assert.equal(history[0]?.utterance.sequence, 6);
    assert.equal(
      history.at(-1)?.utterance.sequence,
      MAX_TRANSCRIPT_ENTRIES + 5,
    );
  });

  it("keeps history separate per room", () => {
    const rooms = new RoomManager();
    const first = expectOk(rooms.createAndJoin("ABC236", joiner("s1")));
    const second = expectOk(rooms.createAndJoin("ABC237", joiner("s2")));
    rooms.recordUtterance(first.room, entry(1));

    assert.equal(rooms.transcriptOf(first.room).length, 1);
    assert.equal(rooms.transcriptOf(second.room).length, 0);
  });

  it("keeps history while the room exists once a participant leaves", () => {
    const rooms = new RoomManager();
    const first = expectOk(rooms.createAndJoin("ABC238", joiner("s1")));
    rooms.recordUtterance(first.room, entry(1));

    rooms.removeBySocket("s1");
    assert.equal(rooms.transcriptOf(first.room).length, 1);

    const rejoined = expectOk(rooms.joinRoom("ABC238", joiner("s2")));
    assert.equal(rooms.transcriptOf(rejoined.room).length, 1);
  });

  it("drops history with the room when it expires, so a reused code starts clean", () => {
    const rooms = new RoomManager();
    const first = expectOk(rooms.createAndJoin("ABC239", joiner("s1")));
    rooms.recordUtterance(first.room, entry(1));
    const departure = rooms.removeBySocket("s1");
    assert.equal(departure?.roomEmpty, true);

    const emptySince = rooms.roomByCode("ABC239")?.emptySince ?? 0;
    assert.deepEqual(rooms.sweepEmptyRooms(emptySince + EMPTY_ROOM_TTL_MS), [
      "ABC239",
    ]);

    const recreated = expectOk(rooms.createAndJoin("ABC239", joiner("s2")));
    assert.equal(rooms.transcriptOf(recreated.room).length, 0);
  });
});
