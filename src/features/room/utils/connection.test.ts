import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  expiredRoomError,
  markWasMember,
  memberStorageKey,
  readWasMember,
  ROOM_EXPIRED_CODE,
  ROOM_EXPIRED_MESSAGE,
  ROOM_JOIN_TIMEOUT_MS,
  shouldTreatAsExpired,
} from "@/features/room/utils/connection";

describe("reconnect policy", () => {
  it("treats room_not_found as expired only for a previous member", () => {
    assert.equal(shouldTreatAsExpired(true, "room_not_found"), true);
    assert.equal(shouldTreatAsExpired(false, "room_not_found"), false);
    assert.equal(shouldTreatAsExpired(true, "room_full"), false);
    assert.equal(shouldTreatAsExpired(true, "invalid_code"), false);
    assert.equal(shouldTreatAsExpired(false, "room_full"), false);
  });

  it("reports the restart message without inventing a room", () => {
    assert.deepEqual(expiredRoomError(), {
      code: ROOM_EXPIRED_CODE,
      message: ROOM_EXPIRED_MESSAGE,
    });
    assert.ok(ROOM_EXPIRED_MESSAGE.includes("server restarted"));
    assert.ok(ROOM_JOIN_TIMEOUT_MS > 0);
  });

  it("records membership per room code in session storage", () => {
    assert.equal(memberStorageKey("ABC234"), "sangam:was-member:ABC234");
    assert.equal(readWasMember("ABC234"), false);
    markWasMember("ABC234");
    assert.equal(readWasMember("ABC234"), true);
    // Membership never leaks across room codes.
    assert.equal(readWasMember("XYZ234"), false);
  });
});
