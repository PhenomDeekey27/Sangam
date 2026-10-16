import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emitRoomJoin } from "@/features/room/services/room-actions";
import type { RoomSocket } from "@/features/room/services/socket";
import {
  hasLanguageParams,
  languageQuery,
  partnerPreferences,
  preferencesFromSearch,
  readLanguagePreferences,
  type LanguagePreferences,
} from "@/features/room/utils/language-preference";
import { seatsFromSnapshot } from "@/features/room/utils/derive";
import type { RoomOpAck } from "@/types/socket";
import { parseJoinPayload } from "../../../../server/src/sockets/event-validation.js";
import { RoomManager } from "../../../../server/src/rooms/room-manager.js";
import { lookupRoomForJoin } from "../../../../server/src/rooms/room-lookup.js";

/**
 * Join-by-code with an explicit pre-join language choice. The join dialog
 * (landing) and the bare-`/room/CODE` pre-join screen both submit the chosen
 * pair through the same path the invite flow uses: `languageQuery` →
 * `preferencesFromSearch` → `emitRoomJoin` (`room:join`) →
 * `parseJoinPayload` → `RoomManager.joinRoom`. The invite-link mirroring
 * itself is untouched (pinned in `invite-flow.test.ts`).
 */

function emitJoinPayload(
  mode: "create" | "join",
  code: string,
  preferences: LanguagePreferences,
): { event: string; payload: Record<string, unknown> } {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const socket = {
    emit: (event: string, payload: unknown, ack?: (r: RoomOpAck) => void) => {
      emitted.push({ event, payload });
      ack?.({ ok: true, self: { id: "self-id", side: "a" } });
      return true;
    },
  } as unknown as RoomSocket;
  emitRoomJoin(
    socket,
    mode,
    {
      code,
      language: preferences.speaking,
      listeningLanguage: preferences.listening,
    },
    {
      notify: () => {},
      silence: () => {},
      onRoomError: () => {},
      onJoined: () => {},
    },
  );
  const first = emitted[0];
  assert.ok(first, "expected the client to emit a create/join");
  return first as { event: string; payload: Record<string, unknown> };
}

function expectParsed(raw: unknown) {
  const parsed = parseJoinPayload(raw);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.value;
}

describe("join by code shows a pre-join language choice", () => {
  it("flags a bare room URL as needing a choice and an invite URL as ready", () => {
    assert.equal(hasLanguageParams({}), false);
    assert.equal(hasLanguageParams({ speak: "ta" }), false);
    assert.equal(hasLanguageParams({ hear: "ta" }), false);
    assert.equal(hasLanguageParams({ speak: "", hear: "ta" }), false);
    assert.equal(hasLanguageParams({ speak: "te", hear: "ta" }), true);
    // Presence only — validity is handled by the existing validators.
    assert.equal(hasLanguageParams({ speak: "klingon", hear: "ta" }), true);
  });

  it("seats Person B with chosen non-English prefs and leaves Person A untouched", () => {
    const rooms = new RoomManager();
    // Person A created speaking Tamil / hearing Telugu.
    const created = rooms.createAndJoin("JCD234", {
      socketId: "socket-a",
      language: "ta",
      listeningLanguage: "te",
      displayName: "",
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    if (!created.ok) throw new Error("unreachable");

    // Person B enters only the code, then picks Telugu / Tamil in the
    // pre-join step (visible, editable; defaults would have been en/en).
    const chosen: LanguagePreferences = { speaking: "te", listening: "ta" };
    const codeUrl = `/room/JCD234?${languageQuery(chosen)}`;
    assert.equal(codeUrl, "/room/JCD234?speak=te&hear=ta");
    const guestPrefs = preferencesFromSearch(
      new URL(codeUrl, "http://localhost").search,
    );
    assert.deepEqual(guestPrefs, chosen);

    // Recognition for Person B follows the chosen speaking language.
    assert.equal(guestPrefs.speaking, "te");

    const guestEmit = emitJoinPayload("join", "JCD234", guestPrefs);
    assert.equal(guestEmit.event, "room:join");
    assert.deepEqual(guestEmit.payload, {
      code: "JCD234",
      language: "te",
      listeningLanguage: "ta",
    });

    const guestPayload = expectParsed(guestEmit.payload);
    const joined = rooms.joinRoom(guestPayload.code, {
      socketId: "socket-b",
      language: guestPayload.language,
      listeningLanguage: guestPayload.listeningLanguage,
      displayName: guestPayload.displayName ?? "",
    });
    assert.equal(joined.ok, true, JSON.stringify(joined));
    if (!joined.ok) throw new Error("unreachable");

    const snapshot = rooms.snapshot(joined.room);
    assert.deepEqual(
      snapshot.participants.map((p) => [
        p.side,
        p.language,
        p.listeningLanguage,
      ]),
      [
        ["a", "ta", "te"],
        ["b", "te", "ta"],
      ],
    );

    // Each seat keeps its own pair; Person A's record is untouched.
    const seats = seatsFromSnapshot(
      snapshot.participants,
      joined.participant.id,
    );
    assert.equal(seats.you?.language, "te");
    assert.equal(seats.you?.listeningLanguage, "ta");
    assert.equal(seats.partner?.language, "ta");
    assert.equal(seats.partner?.listeningLanguage, "te");
  });

  it("rejects an invalid code-join language instead of storing English silently", () => {
    const parsed = parseJoinPayload({
      code: "JCD235",
      language: "klingon",
      listeningLanguage: "ta",
    });
    assert.equal(parsed.ok, false);

    // URL-level half validation still isolates the bad half (existing
    // behavior, unchanged): the good half survives.
    assert.deepEqual(
      readLanguagePreferences({ speak: "klingon", hear: "ta" }),
      {
        speaking: "en",
        listening: "ta",
      },
    );
  });

  it("preserves the chosen pair when the socket rejoins (refresh/reconnect)", () => {
    const rooms = new RoomManager();
    rooms.createAndJoin("JCD236", {
      socketId: "socket-a",
      language: "ta",
      listeningLanguage: "te",
      displayName: "",
    });
    const joined = rooms.joinRoom("JCD236", {
      socketId: "socket-b",
      language: "te",
      listeningLanguage: "ta",
      displayName: "",
    });
    assert.equal(joined.ok, true, JSON.stringify(joined));
    if (!joined.ok) throw new Error("unreachable");
    const seatId = joined.participant.id;

    // The client re-sends the same chosen pair on every reconnect (the
    // preferences now live in the URL after the pre-join choice).
    const resend = emitJoinPayload("join", "JCD236", {
      speaking: "te",
      listening: "ta",
    });
    assert.deepEqual(resend.payload, {
      code: "JCD236",
      language: "te",
      listeningLanguage: "ta",
    });

    // Same socket, same room: identity is stable, the seat follows the
    // latest stated pair, and Person A's seat is untouched.
    const rejoined = rooms.joinRoom("JCD236", {
      socketId: "socket-b",
      language: "te",
      listeningLanguage: "ta",
      displayName: "",
    });
    assert.equal(rejoined.ok, true, JSON.stringify(rejoined));
    if (!rejoined.ok) throw new Error("unreachable");
    assert.equal(rejoined.participant.id, seatId);
    assert.equal(rejoined.participant.side, "b");

    const snapshot = rooms.snapshot(rejoined.room);
    assert.deepEqual(
      snapshot.participants.map((p) => [
        p.side,
        p.language,
        p.listeningLanguage,
      ]),
      [
        ["a", "ta", "te"],
        ["b", "te", "ta"],
      ],
    );
  });
});

describe("code-based language mirroring (French/Punjabi room)", () => {
  it("mirrors the creator's stored pair for the guest before joining", () => {
    const rooms = new RoomManager();
    // Person A creates speaking French / hearing Punjabi.
    const created = rooms.createAndJoin("MFR234", {
      socketId: "socket-a",
      language: "fr",
      listeningLanguage: "pa",
      displayName: "",
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    if (!created.ok) throw new Error("unreachable");

    // Person B pastes only the code: the server lookup returns the
    // creator's stored pair — nothing is hardcoded or defaulted.
    const lookup = lookupRoomForJoin(rooms, "MFR234");
    assert.equal(lookup.ok, true, JSON.stringify(lookup));
    if (!lookup.ok) throw new Error("unreachable");
    assert.deepEqual([lookup.language, lookup.listeningLanguage], ["fr", "pa"]);

    // The dialog mirrors with the same helper the invite link uses.
    const guest: LanguagePreferences = partnerPreferences({
      speaking: lookup.language as "fr",
      listening: lookup.listeningLanguage as "pa",
    });
    assert.deepEqual(guest, { speaking: "pa", listening: "fr" });

    // Joining seats Person B with the mirrored pair; Person A is untouched.
    const before = rooms.snapshot(created.room);
    const joined = rooms.joinRoom("MFR234", {
      socketId: "socket-b",
      language: guest.speaking,
      listeningLanguage: guest.listening,
      displayName: "",
    });
    assert.equal(joined.ok, true, JSON.stringify(joined));
    if (!joined.ok) throw new Error("unreachable");
    assert.equal(joined.participant.side, "b");
    const snapshot = rooms.snapshot(joined.room);
    assert.deepEqual(
      snapshot.participants.map((p) => [
        p.side,
        p.language,
        p.listeningLanguage,
      ]),
      [
        ["a", "fr", "pa"],
        ["b", "pa", "fr"],
      ],
    );
    assert.deepEqual(
      before.participants.map((p) => [p.side, p.language, p.listeningLanguage]),
      [["a", "fr", "pa"]],
    );

    // Recognition follows each seat's own speaking language, never English.
    const seats = seatsFromSnapshot(
      snapshot.participants,
      joined.participant.id,
    );
    assert.equal(seats.you?.language, "pa");
    assert.equal(seats.partner?.language, "fr");
  });

  it("fails code-only joins clearly for bad, unknown, and full rooms", () => {
    const rooms = new RoomManager();
    const malformed = rooms.joinRoom("ABC", {
      socketId: "socket-x",
      language: "pa",
      listeningLanguage: "fr",
      displayName: "",
    });
    assert.equal(malformed.ok, false);
    if (malformed.ok) throw new Error("unreachable");
    assert.equal(malformed.error.code, "invalid_code");

    const unknown = rooms.joinRoom("ZZZZ29", {
      socketId: "socket-x",
      language: "pa",
      listeningLanguage: "fr",
      displayName: "",
    });
    assert.equal(unknown.ok, false);
    if (unknown.ok) throw new Error("unreachable");
    assert.equal(unknown.error.code, "room_not_found");

    rooms.createAndJoin("MFR235", {
      socketId: "socket-a",
      language: "fr",
      listeningLanguage: "pa",
      displayName: "",
    });
    rooms.joinRoom("MFR235", {
      socketId: "socket-b",
      language: "pa",
      listeningLanguage: "fr",
      displayName: "",
    });
    const full = rooms.joinRoom("MFR235", {
      socketId: "socket-c",
      language: "pa",
      listeningLanguage: "fr",
      displayName: "",
    });
    assert.equal(full.ok, false);
    if (full.ok) throw new Error("unreachable");
    assert.equal(full.error.code, "room_full");
  });

  it("reconnects a dropped guest onto the free seat with the mirrored pair", () => {
    const rooms = new RoomManager();
    rooms.createAndJoin("MFR236", {
      socketId: "socket-a",
      language: "fr",
      listeningLanguage: "pa",
      displayName: "",
    });
    const joined = rooms.joinRoom("MFR236", {
      socketId: "socket-b",
      language: "pa",
      listeningLanguage: "fr",
      displayName: "",
    });
    assert.equal(joined.ok, true, JSON.stringify(joined));
    if (!joined.ok) throw new Error("unreachable");

    // Guest's network drops (a refresh is a new socket id): the seat frees,
    // and rejoining with the same mirrored pair reclaims side `b` while
    // Person A's record is untouched.
    rooms.removeBySocket("socket-b");
    const rejoined = rooms.joinRoom("MFR236", {
      socketId: "socket-b2",
      language: "pa",
      listeningLanguage: "fr",
      displayName: "",
    });
    assert.equal(rejoined.ok, true, JSON.stringify(rejoined));
    if (!rejoined.ok) throw new Error("unreachable");
    assert.equal(rejoined.participant.side, "b");
    const snapshot = rooms.snapshot(rejoined.room);
    assert.deepEqual(
      snapshot.participants.map((p) => [
        p.side,
        p.language,
        p.listeningLanguage,
      ]),
      [
        ["a", "fr", "pa"],
        ["b", "pa", "fr"],
      ],
    );
  });
});
