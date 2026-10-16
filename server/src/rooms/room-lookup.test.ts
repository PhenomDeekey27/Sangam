import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createSangamServer, type SangamServer } from "../app.js";
import { RoomManager } from "./room-manager.js";
import { lookupRoomForJoin } from "./room-lookup.js";

describe("lookupRoomForJoin", () => {
  it("returns the creator's stored pair for a code-only join", () => {
    const rooms = new RoomManager();
    rooms.createAndJoin("KUP234", {
      socketId: "socket-a",
      language: "fr",
      listeningLanguage: "pa",
      displayName: "",
    });
    const result = lookupRoomForJoin(rooms, "KUP234");
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) throw new Error("unreachable");
    assert.deepEqual(
      [
        result.code,
        result.language,
        result.listeningLanguage,
        result.seatsTaken,
      ],
      ["KUP234", "fr", "pa", 1],
    );
  });

  it("rejects a malformed code without touching rooms", () => {
    const rooms = new RoomManager();
    const result = lookupRoomForJoin(rooms, "ABC");
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.status, 400);
    assert.equal(result.error.code, "invalid_code");
  });

  it("reports room_not_found for unknown and expired rooms", () => {
    const rooms = new RoomManager();
    const unknown = lookupRoomForJoin(rooms, "ZZZZ29");
    assert.equal(unknown.ok, false);
    if (unknown.ok) throw new Error("unreachable");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.error.code, "room_not_found");

    // The creator left: the room lingers but no creator seat remains, so
    // there is nothing to mirror — same clear verdict as an expired room.
    rooms.createAndJoin("KUP235", {
      socketId: "socket-a",
      language: "fr",
      listeningLanguage: "pa",
      displayName: "",
    });
    rooms.removeBySocket("socket-a");
    const emptied = lookupRoomForJoin(rooms, "KUP235");
    assert.equal(emptied.ok, false);
    if (emptied.ok) throw new Error("unreachable");
    assert.equal(emptied.status, 404);
    assert.equal(emptied.error.code, "room_not_found");
  });

  it("reports room_full when both seats are taken", () => {
    const rooms = new RoomManager();
    rooms.createAndJoin("KUP236", {
      socketId: "socket-a",
      language: "fr",
      listeningLanguage: "pa",
      displayName: "",
    });
    rooms.joinRoom("KUP236", {
      socketId: "socket-b",
      language: "pa",
      listeningLanguage: "fr",
      displayName: "",
    });
    const result = lookupRoomForJoin(rooms, "KUP236");
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.status, 409);
    assert.equal(result.error.code, "room_full");
  });
});

describe("GET /api/rooms/:code", () => {
  let server: SangamServer;
  let url: string;

  before(async () => {
    server = createSangamServer({
      port: 0,
      clientOrigins: ["http://localhost:3000"],
      isProduction: false,
    });
    server.rooms.createAndJoin("HTTP23", {
      socketId: "socket-a",
      language: "fr",
      listeningLanguage: "pa",
      displayName: "",
    });
    await server.listen();
    const address = server.httpServer.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await server.close();
  });

  it("serves the creator's pair and nothing else", async () => {
    const response = await fetch(`${url}/api/rooms/HTTP23`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(body, {
      ok: true,
      code: "HTTP23",
      language: "fr",
      listeningLanguage: "pa",
      seatsTaken: 1,
    });
  });

  it("answers unknown rooms with room_not_found", async () => {
    const response = await fetch(`${url}/api/rooms/ZZZZ29`);
    assert.equal(response.status, 404);
    const body = (await response.json()) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "room_not_found");
    assert.ok(body.error.message.length > 0);
  });

  it("answers malformed codes with invalid_code", async () => {
    const response = await fetch(`${url}/api/rooms/ABC`);
    assert.equal(response.status, 400);
    const body = (await response.json()) as {
      ok: boolean;
      error: { code: string };
    };
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "invalid_code");
  });
});
