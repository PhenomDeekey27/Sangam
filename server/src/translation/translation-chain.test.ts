import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Server } from "socket.io";
import { RoomManager } from "../rooms/room-manager.js";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "../sockets/contract.js";
import { MockTranslator } from "./mock-translator.js";
import {
  TranslationProviderError,
  type TranslationRequest,
  type Translator,
} from "./translator.js";
import {
  ChainedTranslator,
  type ChainAttemptInfo,
} from "./translation-chain.js";
import { TranslationService } from "./translation-service.js";

/**
 * Orchestration tests for primary → fallback translation. HTTP is mocked
 * throughout; live-endpoint behavior is covered only by the smoke test.
 */

/** Scriptable primary stand-in with a call counter. */
class FakePrimary implements Translator {
  readonly calls: TranslationRequest[] = [];
  constructor(
    private readonly behavior: (request: TranslationRequest) => Promise<{
      readonly text: string;
      readonly targetLanguage: string;
    }>,
  ) {}
  translate(request: TranslationRequest) {
    this.calls.push(request);
    return this.behavior(request);
  }
}

function succeed(text: string) {
  return async (request: TranslationRequest) => ({
    text,
    targetLanguage: request.targetLanguage,
  });
}

function failWith(code: "timeout" | "network" | "rate_limited" | "auth" | "unknown" | "unsupported") {
  return async () => {
    throw new TranslationProviderError(code, `fake ${code}`);
  };
}

const REQUEST: TranslationRequest = {
  text: "வணக்கம்",
  sourceLanguage: "ta",
  targetLanguage: "en",
};

describe("ChainedTranslator routing", () => {
  it("returns the primary result without touching the fallback", async () => {
    const primary = new FakePrimary(succeed("Hello"));
    const fallback = new MockTranslator({
      canned: { ta: { en: { "வணக்கம்": "Hello via fallback" } } },
    });
    const attempts: ChainAttemptInfo[] = [];
    const chain = new ChainedTranslator({
      primary,
      fallback,
      onAttempt: (info) => attempts.push(info),
    });
    const result = await chain.translate(REQUEST);
    assert.deepEqual(result, { text: "Hello", targetLanguage: "en" });
    assert.equal(primary.calls.length, 1);
    assert.equal(fallback.calls.length, 0);
    assert.deepEqual(
      attempts.map((a) => [a.provider, a.ok]),
      [["google", true]],
    );
  });

  it("falls back on 403, timeout, and malformed primary results", async () => {
    const codes = ["auth", "timeout", "unknown", "network", "rate_limited"] as const;
    for (const code of codes) {
      const primary = new FakePrimary(failWith(code));
      const fallback = new MockTranslator({
        canned: { ta: { en: { "வணக்கம்": "Hello" } } },
      });
      const attempts: ChainAttemptInfo[] = [];
      const chain = new ChainedTranslator({
        primary,
        fallback,
        onAttempt: (info) => attempts.push(info),
      });
      const result = await chain.translate(REQUEST);
      assert.equal(result.text, "Hello");
      assert.equal(primary.calls.length, 1);
      assert.equal(fallback.calls.length, 1);
      assert.deepEqual(
        attempts.map((a) => [a.provider, a.ok]),
        [
          ["google", false],
          ["gemini", true],
        ],
      );
      assert.equal(attempts[0]?.code, code);
    }
  });

  it("never falls back for unsupported pairs", async () => {
    const primary = new FakePrimary(failWith("unsupported"));
    const fallback = new MockTranslator({
      canned: { ta: { en: { "வணக்கம்": "Hello" } } },
    });
    const chain = new ChainedTranslator({ primary, fallback });
    await assert.rejects(chain.translate(REQUEST), (error: unknown) => {
      assert.ok(error instanceof TranslationProviderError);
      assert.equal(error.code, "unsupported");
      return true;
    });
    assert.equal(fallback.calls.length, 0);
  });

  it("propagates the primary error when fallback is disabled", async () => {
    const primary = new FakePrimary(failWith("timeout"));
    const chain = new ChainedTranslator({ primary, fallback: null });
    await assert.rejects(chain.translate(REQUEST), (error: unknown) => {
      assert.ok(error instanceof TranslationProviderError);
      assert.equal(error.code, "timeout");
      return true;
    });
  });

  it("throws the fallback error when both providers fail", async () => {
    const primary = new FakePrimary(failWith("network"));
    const fallback = new MockTranslator({
      failures: { ta: { en: { "வணக்கம்": "auth" } } },
    });
    const chain = new ChainedTranslator({ primary, fallback });
    await assert.rejects(chain.translate(REQUEST), (error: unknown) => {
      assert.ok(error instanceof TranslationProviderError);
      assert.equal(error.code, "auth");
      return true;
    });
  });
});

describe("ChainedTranslator stage diagnostics", () => {
  it("reports the fallback start and the google final provider", async () => {
    const stages: string[] = [];
    const chain = new ChainedTranslator({
      primary: new FakePrimary(succeed("Hello")),
      fallback: new MockTranslator({
        canned: { ta: { en: { "வணக்கம்": "Hello via fallback" } } },
      }),
      onFallbackStart: () => stages.push("gemini fallback started"),
      onFinal: (info) => stages.push(`final provider: ${info.provider}`),
    });
    await chain.translate(REQUEST);
    assert.deepEqual(stages, ["final provider: google"]);
  });

  it("reports fallback-started and gemini as the final provider", async () => {
    const stages: string[] = [];
    const chain = new ChainedTranslator({
      primary: new FakePrimary(failWith("timeout")),
      fallback: new MockTranslator({
        canned: { ta: { en: { "வணக்கம்": "Hello" } } },
      }),
      onFallbackStart: () => stages.push("gemini fallback started"),
      onFinal: (info) => stages.push(`final provider: ${info.provider}`),
    });
    const result = await chain.translate(REQUEST);
    assert.equal(result.text, "Hello");
    assert.deepEqual(stages, [
      "gemini fallback started",
      "final provider: gemini",
    ]);
  });

  it("reports none when both providers fail", async () => {
    const stages: string[] = [];
    const chain = new ChainedTranslator({
      primary: new FakePrimary(failWith("network")),
      fallback: new MockTranslator({
        failures: { ta: { en: { "வணக்கம்": "unknown" } } },
      }),
      onFallbackStart: () => stages.push("gemini fallback started"),
      onFinal: (info) => stages.push(`final provider: ${info.provider}`),
    });
    await assert.rejects(chain.translate(REQUEST));
    assert.deepEqual(stages, [
      "gemini fallback started",
      "final provider: none",
    ]);
  });

  it("reports none without a fallback and never announces one", async () => {
    const stages: string[] = [];
    const chain = new ChainedTranslator({
      primary: new FakePrimary(failWith("network")),
      fallback: null,
      onFallbackStart: () => stages.push("gemini fallback started"),
      onFinal: (info) => stages.push(`final provider: ${info.provider}`),
    });
    await assert.rejects(chain.translate(REQUEST));
    assert.deepEqual(stages, ["final provider: none"]);
  });
});

describe("ChainedTranslator with TranslationService", () => {
  type AppServer = Server<ClientToServerEvents, ServerToClientEvents>;

  function stubIo(emitted: Array<{ event: string; payload: unknown }>) {
    return {
      to: () => ({
        emit: (event: string, payload: unknown) => {
          emitted.push({ event, payload });
        },
      }),
    } as unknown as AppServer;
  }

  function flush(ms = 10): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function twoSeatRoom(rooms: RoomManager, code: string) {
    const created = rooms.createAndJoin(code, {
      socketId: `socket-a-${code}`,
      language: "ta",
      listeningLanguage: "ta",
      displayName: "",
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    if (!created.ok) throw new Error("unreachable");
    const joined = rooms.joinRoom(code, {
      socketId: `socket-b-${code}`,
      language: "en",
      listeningLanguage: "en",
      displayName: "",
    });
    assert.equal(joined.ok, true, JSON.stringify(joined));
    if (!joined.ok) throw new Error("unreachable");
    return joined.room;
  }

  it("completes from fallback after a primary timeout, exactly once", async () => {
    const rooms = new RoomManager();
    const room = twoSeatRoom(rooms, "TRC234");
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const primary = new FakePrimary(failWith("timeout"));
    const fallback = new MockTranslator({
      canned: { ta: { en: { "வணக்கம்": "Hello" } } },
    });
    const service = new TranslationService(
      stubIo(emitted),
      rooms,
      new ChainedTranslator({ primary, fallback }),
    );
    const entry = {
      utterance: {
        id: "utt-chain-ta-01",
        speakerSide: "a" as const,
        language: "ta",
        text: "வணக்கம்",
        finalizedAt: Date.now(),
        sequence: 1,
      },
      translation: { status: "unavailable" as const },
    };
    rooms.recordUtterance(room, entry);
    service.translateUtterance(room, entry);
    await flush();
    assert.equal(entry.utterance.text, "வணக்கம்");
    assert.deepEqual(entry.translation, {
      status: "complete",
      text: "Hello",
      targetLanguage: "en",
    });
    assert.equal(primary.calls.length, 1);
    assert.equal(fallback.calls.length, 1);
    const updates = emitted.filter(
      (item) => item.event === "conversation:translation",
    );
    assert.equal(updates.length, 1);
    assert.equal(
      (updates[0]?.payload as { utteranceId: string }).utteranceId,
      "utt-chain-ta-01",
    );
  });

  it("keeps the original visible when both providers fail", async () => {
    const rooms = new RoomManager();
    const room = twoSeatRoom(rooms, "TRC235");
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const primary = new FakePrimary(failWith("network"));
    const fallback = new MockTranslator({
      failures: { ta: { en: { "வணக்கம்": "unknown" } } },
    });
    const service = new TranslationService(
      stubIo(emitted),
      rooms,
      new ChainedTranslator({ primary, fallback }),
    );
    const entry = {
      utterance: {
        id: "utt-chain-ta-02",
        speakerSide: "a" as const,
        language: "ta",
        text: "வணக்கம்",
        finalizedAt: Date.now(),
        sequence: 1,
      },
      translation: { status: "unavailable" as const },
    };
    rooms.recordUtterance(room, entry);
    service.translateUtterance(room, entry);
    await flush();
    assert.equal(entry.utterance.text, "வணக்கம்");
    assert.equal(entry.translation.status, "failed");
    assert.equal(emitted.length, 1);
  });
});
