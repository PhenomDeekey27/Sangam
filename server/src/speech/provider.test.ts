import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSpeechEnv } from "../config/env.js";
import { createMockSpeechProvider } from "./mock-provider.js";
import {
  createDeepgramSpeechProvider,
  readTranscript,
  type DeepgramSocket,
} from "./deepgram-provider.js";
import { createSpeechProvider } from "./provider-factory.js";
import type { SpeechProviderError } from "./provider.js";

describe("resolveSpeechEnv", () => {
  it("selects deepgram only when a key is present", () => {
    assert.equal(resolveSpeechEnv({}).provider, "none");
    assert.equal(resolveSpeechEnv({ provider: "auto" }).provider, "none");
    assert.equal(
      resolveSpeechEnv({ provider: "auto", deepgramApiKey: "k" }).provider,
      "deepgram",
    );
    assert.equal(resolveSpeechEnv({ provider: "mock" }).provider, "mock");
    assert.equal(
      resolveSpeechEnv({ provider: "none", deepgramApiKey: "k" }).provider,
      "none",
    );
  });

  it("refuses an explicit deepgram mode without a key", () => {
    assert.throws(
      () => resolveSpeechEnv({ provider: "deepgram" }),
      /DEEPGRAM_API_KEY/,
    );
  });

  it("falls back to auto for an unknown mode and clamps the byte ceiling", () => {
    const resolved = resolveSpeechEnv({ provider: "wat", maxSessionBytes: 0 });
    assert.equal(resolved.mode, "auto");
    assert.ok(resolved.maxSessionBytes > 0);
  });
});

describe("createSpeechProvider", () => {
  it("maps the resolved provider id to an implementation", () => {
    assert.equal(
      createSpeechProvider(resolveSpeechEnv({ provider: "mock" })).id,
      "mock",
    );
    assert.equal(createSpeechProvider(resolveSpeechEnv({})).id, "none");
    assert.equal(
      createSpeechProvider(
        resolveSpeechEnv({ provider: "auto", deepgramApiKey: "key" }),
      ).id,
      "deepgram",
    );
  });
});

describe("mock provider", () => {
  it("emits one interim and one final per session", () => {
    const provider = createMockSpeechProvider({
      interim: "interim {language}",
      final: "final {language}",
      finalAfterBytes: 8,
    });
    const interims: string[] = [];
    const finals: string[] = [];
    let closes = 0;
    const session = provider.open({
      language: "te",
      onInterim: (t) => interims.push(t),
      onFinal: (t) => finals.push(t),
      onError: () => {},
      onClose: () => {
        closes += 1;
      },
    });

    session.push(new Uint8Array(4));
    assert.deepEqual(interims, ["interim te"]);
    assert.deepEqual(finals, []);
    session.push(new Uint8Array(4));
    assert.deepEqual(finals, ["final te"]);
    assert.equal(closes, 1);
  });

  it("flushes buffered audio on stop and stays silent after close", () => {
    const provider = createMockSpeechProvider({
      interim: "i",
      final: "f",
      finalAfterBytes: 999,
    });
    const finals: string[] = [];
    const session = provider.open({
      language: "ta",
      onInterim: () => {},
      onFinal: (t) => finals.push(t),
      onError: () => {},
      onClose: () => {},
    });
    session.push(new Uint8Array(2));
    session.stop();
    assert.deepEqual(finals, ["f"]);
    session.close();
    session.push(new Uint8Array(1));
    assert.deepEqual(finals, ["f"]);
  });
});

describe("readTranscript", () => {
  it("reads interim and final Results and ignores everything else", () => {
    const interim = JSON.stringify({
      type: "Results",
      is_final: false,
      channel: { alternatives: [{ transcript: "Vana" }] },
    });
    const final = JSON.stringify({
      type: "Results",
      is_final: true,
      channel: { alternatives: [{ transcript: "Vanakkam" }] },
    });
    assert.deepEqual(readTranscript(interim), {
      text: "Vana",
      isFinal: false,
    });
    assert.deepEqual(readTranscript(final), {
      text: "Vanakkam",
      isFinal: true,
    });
    assert.equal(readTranscript(JSON.stringify({ type: "Metadata" })), null);
    assert.equal(readTranscript("{not json"), null);
    assert.equal(
      readTranscript(
        JSON.stringify({
          type: "Results",
          channel: { alternatives: [{ transcript: "  " }] },
        }),
      ),
      null,
    );
  });
});

class FakeSocket implements DeepgramSocket {
  readonly sent: (string | ArrayBufferLike | ArrayBufferView)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
}

describe("deepgram adapter (unverified against the live service)", () => {
  it("targets the selected language and forwards transcripts", () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    const provider = createDeepgramSpeechProvider({
      apiKey: "secret",
      createSocket: (url) => {
        openedUrl = url;
        return socket;
      },
    });
    const interims: string[] = [];
    const finals: string[] = [];
    const session = provider.open({
      language: "te",
      onInterim: (t) => interims.push(t),
      onFinal: (t) => finals.push(t),
      onError: () => {},
      onClose: () => {},
    });

    assert.match(openedUrl, /language=te/);
    assert.match(openedUrl, /interim_results=true/);
    assert.ok(!openedUrl.includes("secret"));

    socket.onmessage?.({
      data: JSON.stringify({
        type: "Results",
        is_final: true,
        channel: { alternatives: [{ transcript: "Namaskaram" }] },
      }),
    });
    assert.deepEqual(finals, ["Namaskaram"]);

    session.stop();
    assert.equal(socket.sent.at(-1), JSON.stringify({ type: "CloseStream" }));
  });

  it("reports an auth failure once and mutes later callbacks after close", () => {
    const socket = new FakeSocket();
    const errors: SpeechProviderError[] = [];
    const provider = createDeepgramSpeechProvider({
      apiKey: "secret",
      createSocket: () => socket,
    });
    const session = provider.open({
      language: "hi",
      onInterim: () => {},
      onFinal: () => {},
      onError: (error) => errors.push(error),
      onClose: () => {},
    });

    socket.onerror?.();
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.code, "provider_auth");

    session.close();
    const handler = socket.onmessage;
    assert.equal(handler, null);
    assert.equal(socket.closed, true);
  });

  it("reports a missing runtime WebSocket instead of throwing", () => {
    const provider = createDeepgramSpeechProvider({
      apiKey: "secret",
      createSocket: () => {
        throw new Error("no websocket");
      },
    });
    const errors: SpeechProviderError[] = [];
    provider.open({
      language: "en",
      onInterim: () => {},
      onFinal: () => {},
      onError: (error) => errors.push(error),
      onClose: () => {},
    });
    assert.equal(errors[0]?.code, "provider_unavailable");
  });
});
