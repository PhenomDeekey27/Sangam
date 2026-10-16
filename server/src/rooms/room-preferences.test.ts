import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RoomManager, type JoinRequest } from "./room-manager.js";
import { DEFAULT_LISTENING_LANGUAGE } from "./room-validation.js";

function joiner(
  socketId: string,
  overrides: Partial<JoinRequest> = {},
): JoinRequest {
  return { socketId, language: "en", displayName: "", ...overrides };
}

function expectOk<T extends { ok: boolean }>(
  result: T,
): Extract<T, { ok: true }> {
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

describe("language preferences are stored per participant", () => {
  it("keeps a non-English speaking language and the listening preference", () => {
    const rooms = new RoomManager();
    const created = expectOk(
      rooms.createAndJoin(
        "ABCD23",
        joiner("socket-a", { language: "hi", listeningLanguage: "ta" }),
      ),
    );
    assert.equal(created.participant.language, "hi");
    assert.equal(created.participant.listeningLanguage, "ta");
  });

  it("defaults only the half that was not supplied", () => {
    const rooms = new RoomManager();
    const created = expectOk(
      rooms.createAndJoin("ABCD24", joiner("socket-a", { language: "ta" })),
    );
    assert.equal(created.participant.language, "ta");
    assert.equal(
      created.participant.listeningLanguage,
      DEFAULT_LISTENING_LANGUAGE,
    );

    const nulled = expectOk(
      rooms.createAndJoin(
        "ABCD25",
        joiner("socket-b", { language: "hi", listeningLanguage: null }),
      ),
    );
    assert.equal(nulled.participant.language, "hi");
    assert.equal(nulled.participant.listeningLanguage, "en");
  });

  it("never lets one seat's preferences overwrite the other seat's", () => {
    const rooms = new RoomManager();
    const first = expectOk(
      rooms.createAndJoin(
        "EFGH23",
        joiner("socket-a", { language: "hi", listeningLanguage: "ta" }),
      ),
    );
    const second = expectOk(
      rooms.joinRoom(
        "EFGH23",
        joiner("socket-b", { language: "ta", listeningLanguage: "hi" }),
      ),
    );

    const snapshot = rooms.snapshot(second.room);
    assert.deepEqual(
      snapshot.participants.map((p) => [
        p.side,
        p.language,
        p.listeningLanguage,
      ]),
      [
        ["a", "hi", "ta"],
        ["b", "ta", "hi"],
      ],
    );

    // The creator's record is the same object it always was.
    const creator = expectOk(rooms.joinRoom("EFGH23", joiner("socket-a")));
    assert.equal(creator.participant.id, first.participant.id);
    assert.equal(creator.participant.language, "hi");
    assert.equal(creator.participant.listeningLanguage, "ta");
  });

  it("replaces only the rejoining seat when preferences change", () => {
    const rooms = new RoomManager();
    expectOk(
      rooms.createAndJoin(
        "JKLM23",
        joiner("socket-a", { language: "en", listeningLanguage: "hi" }),
      ),
    );
    expectOk(
      rooms.joinRoom(
        "JKLM23",
        joiner("socket-b", { language: "ta", listeningLanguage: "ml" }),
      ),
    );

    // B's socket drops, then a fresh one rejoins with different preferences.
    rooms.removeBySocket("socket-b");
    const rejoined = expectOk(
      rooms.joinRoom(
        "JKLM23",
        joiner("socket-b2", { language: "kn", listeningLanguage: "gu" }),
      ),
    );
    assert.equal(rejoined.participant.side, "b");
    assert.equal(rejoined.participant.language, "kn");
    assert.equal(rejoined.participant.listeningLanguage, "gu");

    const snapshot = rooms.snapshot(rejoined.room);
    const seatA = snapshot.participants.find((p) => p.side === "a");
    assert.equal(seatA?.language, "en");
    assert.equal(seatA?.listeningLanguage, "hi");
  });

  it("exposes both preferences on every participant snapshot", () => {
    const rooms = new RoomManager();
    const created = expectOk(
      rooms.createAndJoin(
        "NPQR23",
        joiner("socket-a", { language: "bn", listeningLanguage: "es" }),
      ),
    );
    assert.deepEqual(rooms.snapshot(created.room).participants[0], {
      id: created.participant.id,
      side: "a",
      status: "connected",
      displayName: "Speaker A",
      language: "bn",
      listeningLanguage: "es",
    });
  });
});
