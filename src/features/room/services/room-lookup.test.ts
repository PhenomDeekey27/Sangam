import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchRoomLookup } from "@/features/room/services/room-lookup";

/**
 * The join dialog's server lookup: the creator's stored pair maps to the
 * mirrored guest pair, membership verdicts block with the server's message,
 * and transport failures stay non-blocking so the validated `room:join`
 * round trip remains authoritative.
 */
describe("fetchRoomLookup", () => {
  const realFetch = globalThis.fetch;

  function stubFetch(
    handler: (
      url: string,
    ) => Promise<{ ok: boolean; status: number; body: unknown }>,
  ): string[] {
    const seen: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      seen.push(url);
      const result = await handler(url);
      return {
        ok: result.ok,
        status: result.status,
        json: async () => result.body,
      };
    }) as typeof fetch;
    return seen;
  }

  // Each test restores the real fetch via after-style cleanup below.
  const restores: Array<() => void> = [];
  function afterEachRestore(): void {
    while (restores.length > 0) restores.pop()?.();
  }

  it("maps a creator pair to the mirrored guest pair", async () => {
    const seen = stubFetch(async () => ({
      ok: true,
      status: 200,
      body: {
        ok: true,
        code: "MFR237",
        language: "fr",
        listeningLanguage: "pa",
        seatsTaken: 1,
      },
    }));
    restores.push(() => {
      globalThis.fetch = realFetch;
    });
    try {
      const result = await fetchRoomLookup("MFR237");
      assert.equal(result.status, "ready");
      if (result.status !== "ready") throw new Error("unreachable");
      assert.deepEqual(result.creator, { speaking: "fr", listening: "pa" });
      assert.deepEqual(result.guest, { speaking: "pa", listening: "fr" });
      assert.ok(seen[0]?.includes("/api/rooms/MFR237"));
    } finally {
      afterEachRestore();
    }
  });

  it("blocks on unknown rooms with the server's message", async () => {
    stubFetch(async () => ({
      ok: false,
      status: 404,
      body: {
        ok: false,
        error: { code: "room_not_found", message: "That room does not exist." },
      },
    }));
    restores.push(() => {
      globalThis.fetch = realFetch;
    });
    try {
      const result = await fetchRoomLookup("ZZZZ29");
      assert.deepEqual(result, {
        status: "failed",
        code: "room_not_found",
        message: "That room does not exist.",
        blocking: true,
      });
    } finally {
      afterEachRestore();
    }
  });

  it("lets the join round trip decide when the server is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    restores.push(() => {
      globalThis.fetch = realFetch;
    });
    try {
      const result = await fetchRoomLookup("MFR238");
      assert.equal(result.status, "failed");
      if (result.status !== "failed") throw new Error("unreachable");
      assert.equal(result.blocking, false);
    } finally {
      afterEachRestore();
    }
  });
});
