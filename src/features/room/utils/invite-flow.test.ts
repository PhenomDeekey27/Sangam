import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  languageQuery,
  preferencesFromSearch,
  readLanguagePreferences,
  roomInvitePath,
  type LanguagePreferences,
} from "@/features/room/utils/language-preference";
import { emitRoomJoin } from "@/features/room/services/room-actions";
import type { RoomSocket } from "@/features/room/services/socket";
import { seatsFromSnapshot } from "@/features/room/utils/derive";
import { languageLabel } from "@/features/translation/data/languages";
import type { RoomOpAck } from "@/types/socket";
import { parseJoinPayload } from "../../../../server/src/sockets/event-validation.js";
import { RoomManager } from "../../../../server/src/rooms/room-manager.js";

/**
 * The URL leg of create → invite → join, composed from the real helpers the
 * landing screen (`languageQuery`), the room route
 * (`preferencesFromSearch`/`readLanguagePreferences`), the invite dialog
 * (`roomInvitePath`), the real client join sender (`emitRoomJoin` — the exact
 * function `useRoomSocket` calls for `room:create`/`room:join`), the socket
 * layer (`parseJoinPayload` — the exact function the server's
 * `room:create`/`room:join` handlers call), and the real `RoomManager` seats.
 * The same mirrored pair is exercised over live sockets in the server
 * `invite-flow` test.
 *
 * The first test pins all five surfaces for the Tamil/Telugu pair: the room
 * URL, the participant tiles (`languageLabel` over the server snapshot, the
 * same values `ParticipantTile` renders), the client state (the `emitRoomJoin`
 * payload), the server seat (`RoomManager` snapshot), and the recognition
 * language (the speaking preference that `useRoomConversation` hands to
 * `useSpeechCapture` and that `speech:start` must match).
 */

/**
 * Capture what the real client join sender emits for one participant, and ack
 * it as a successful seat so the caller learns the server-assigned identity.
 */
function emitJoinPayload(
  mode: "create" | "join",
  code: string,
  preferences: LanguagePreferences,
): { event: string; payload: Record<string, unknown> } {
  const emitted: Array<{
    event: string;
    payload: unknown;
  }> = [];
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

describe("create → invite → join preserves preferences end to end", () => {
  it("seats Person A from the landing selections and Person B from the invite", () => {
    const rooms = new RoomManager();
    // Person A selects Tamil / Telugu on the landing screen and creates.
    const personA: LanguagePreferences = { speaking: "ta", listening: "te" };
    const creatorUrl = `/room/FLW234?${languageQuery(personA)}&create=1`;
    // Room URL carries Person A's own pair (landing `languageQuery` output).
    assert.equal(creatorUrl, "/room/FLW234?speak=ta&hear=te&create=1");
    // The room route parses the URL into this participant's preferences.
    const creatorPrefs = preferencesFromSearch(
      new URL(creatorUrl, "http://localhost").search,
    );
    assert.deepEqual(creatorPrefs, personA);

    // Client state: the real join sender emits both preferences on create.
    const creatorEmit = emitJoinPayload("create", "FLW234", creatorPrefs);
    assert.equal(creatorEmit.event, "room:create");
    assert.deepEqual(creatorEmit.payload, {
      code: "FLW234",
      language: "ta",
      listeningLanguage: "te",
    });

    const createdPayload = expectParsed(creatorEmit.payload);
    const created = rooms.createAndJoin(createdPayload.code, {
      socketId: "socket-a",
      language: createdPayload.language,
      listeningLanguage: createdPayload.listeningLanguage,
      displayName: createdPayload.displayName ?? "",
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    if (!created.ok) throw new Error("unreachable");
    assert.equal(created.participant.side, "a");
    // Server seat agrees with the room URL and the client payload.
    assert.equal(created.participant.language, "ta");
    assert.equal(created.participant.listeningLanguage, "te");
    // Recognition language is the seat's own speaking language.
    assert.equal(creatorPrefs.speaking, created.participant.language);

    // Person A's invite dialog mirrors the pair for the partner.
    const invite = roomInvitePath("FLW234", personA);
    assert.equal(invite, "/room/FLW234?speak=te&hear=ta");

    // Person B opens that exact link in a fresh session: Telugu/Tamil, never
    // English. The invite path is Person B's room URL.
    const guestPrefs = preferencesFromSearch(invite.split("?")[1] ?? "");
    assert.deepEqual(guestPrefs, { speaking: "te", listening: "ta" });

    // Client state for Person B: the real join sender emits the mirrored pair.
    const guestEmit = emitJoinPayload("join", "FLW234", guestPrefs);
    assert.equal(guestEmit.event, "room:join");
    assert.deepEqual(guestEmit.payload, {
      code: "FLW234",
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

    // Participant tiles render the same server snapshot both clients share:
    // Tamil/Telugu for side `a`, Telugu/Tamil for side `b`.
    const seats = seatsFromSnapshot(
      snapshot.participants,
      joined.participant.id,
    );
    assert.equal(seats.partner?.side, "a");
    assert.equal(languageLabel(seats.you?.language ?? "en"), "Telugu");
    assert.equal(languageLabel(seats.you?.listeningLanguage ?? "en"), "Tamil");
    assert.equal(languageLabel(seats.partner?.language ?? "en"), "Tamil");
    assert.equal(
      languageLabel(seats.partner?.listeningLanguage ?? "en"),
      "Telugu",
    );
    // Recognition language for each seat is that seat's own speaking language.
    assert.equal(seats.you?.language, guestPrefs.speaking);
    assert.equal(seats.partner?.language, personA.speaking);
  });

  it("joins by bare code with the documented default, never fake invite prefs", () => {
    const rooms = new RoomManager();
    rooms.createAndJoin("FLW235", {
      socketId: "socket-a",
      language: "ta",
      listeningLanguage: "es",
      displayName: "",
    });
    // No language parameters at all (a bare `/room/FLW235` URL or a code-only
    // join without opening the invite link): the documented default applies.
    // This must not pretend the invite preferences arrived when they did not.
    assert.equal(new URLSearchParams("").toString(), "");
    const manual = readLanguagePreferences({});
    assert.deepEqual(manual, { speaking: "en", listening: "en" });

    const manualEmit = emitJoinPayload("join", "FLW235", manual);
    assert.deepEqual(manualEmit.payload, {
      code: "FLW235",
      language: "en",
      listeningLanguage: "en",
    });
    const guestPayload = expectParsed(manualEmit.payload);
    const joined = rooms.joinRoom(guestPayload.code, {
      socketId: "socket-b",
      language: guestPayload.language,
      listeningLanguage: guestPayload.listeningLanguage,
      displayName: guestPayload.displayName ?? "",
    });
    assert.equal(joined.ok, true, JSON.stringify(joined));
    if (!joined.ok) throw new Error("unreachable");
    const seatB = rooms
      .snapshot(joined.room)
      .participants.find((p) => p.side === "b");
    assert.deepEqual([seatB?.language, seatB?.listeningLanguage], ["en", "en"]);
  });

  it("follows the latest stated preferences when the socket rejoins", () => {
    const rooms = new RoomManager();
    rooms.createAndJoin("FLW236", {
      socketId: "socket-a",
      language: "en",
      listeningLanguage: "en",
      displayName: "",
    });
    // A same-tab invite-link paste re-sends the join on the same socket: the
    // seat follows without changing sides or touching the partner seat.
    const rejoined = rooms.joinRoom("FLW236", {
      socketId: "socket-a",
      language: "es",
      listeningLanguage: "ta",
      displayName: "",
    });
    assert.equal(rejoined.ok, true, JSON.stringify(rejoined));
    if (!rejoined.ok) throw new Error("unreachable");
    assert.equal(rejoined.participant.side, "a");
    assert.equal(rejoined.participant.language, "es");
    assert.equal(rejoined.participant.listeningLanguage, "ta");
  });

  it("rejects an invalid language instead of silently forcing English", () => {
    const parsed = parseJoinPayload({
      code: "FLW237",
      language: "klingon",
      listeningLanguage: "ta",
    });
    assert.equal(parsed.ok, false);
  });
});
