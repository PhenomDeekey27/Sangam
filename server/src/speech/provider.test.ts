import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSpeechEnv } from "../config/env.js";
import { RoomManager } from "../rooms/room-manager.js";
import { createMockSpeechProvider } from "./mock-provider.js";
import {
  createDeepgramSpeechProvider,
  DEEPGRAM_LANGUAGES,
  readTranscript,
  type DeepgramSocket,
} from "./deepgram-provider.js";
import { createSpeechProvider } from "./provider-factory.js";
import type { SpeechProviderError } from "./provider.js";
import { SpeechSessions } from "./speech-sessions.js";

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

  it("builds a deepgram provider only when a key is configured", () => {
    assert.equal(
      createSpeechProvider(
        resolveSpeechEnv({ provider: "deepgram", deepgramApiKey: "key" }),
      ).id,
      "deepgram",
    );
    // `auto` without a key, or an explicit `none`, never builds one.
    assert.equal(
      createSpeechProvider(resolveSpeechEnv({ provider: "auto" })).id,
      "none",
    );
  });
});

describe("server capability advertisement", () => {
  function capabilitiesFor(input: Parameters<typeof resolveSpeechEnv>[0]) {
    const sessions = new SpeechSessions(
      {} as never,
      new RoomManager(),
      resolveSpeechEnv(input),
    );
    return sessions.capabilities();
  }

  it("advertises deepgram streaming when a key is configured", () => {
    const capabilities = capabilitiesFor({
      provider: "auto",
      deepgramApiKey: "placeholder-key-for-test",
    });
    assert.equal(capabilities.provider, "deepgram");
    assert.equal(capabilities.streaming, true);
    assert.equal(capabilities.interim, true);
    for (const language of ["en", "hi", "ta", "te"]) {
      assert.ok(
        (capabilities.languages as readonly string[]).includes(language),
        `expected ${language} to be advertised`,
      );
    }
  });

  it("advertises no server provider when no key is configured", () => {
    const capabilities = capabilitiesFor({ provider: "auto" });
    assert.equal(capabilities.provider, "none");
    assert.equal(capabilities.streaming, false);
    assert.deepEqual(capabilities.languages, []);
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

  it("sends the selected model and language without the key in the URL", () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    let openedProtocols: readonly string[] = [];
    const provider = createDeepgramSpeechProvider({
      apiKey: "secret",
      model: "nova-3",
      createSocket: (url, protocols) => {
        openedUrl = url;
        openedProtocols = protocols;
        return socket;
      },
    });
    provider.open({
      language: "ta",
      onInterim: () => {},
      onFinal: () => {},
      onError: () => {},
      onClose: () => {},
    });
    const params = new URL(openedUrl).searchParams;
    assert.equal(params.get("model"), "nova-3");
    assert.equal(params.get("language"), "ta");
    assert.equal(params.get("interim_results"), "true");
    assert.equal(openedProtocols[0], "token");
    assert.ok(!openedUrl.includes("secret"));
  });

  it("covers the nova-3 streaming subset of Sangam languages", () => {
    const supported = DEEPGRAM_LANGUAGES as readonly string[];
    for (const language of ["en", "hi", "ta", "te", "es"]) {
      assert.ok(supported.includes(language), `expected ${language}`);
    }
    for (const language of ["mr", "kn", "ml"]) {
      assert.ok(!supported.includes(language), `unexpected ${language}`);
    }
  });
});

describe("deepgram session error semantics", () => {
  function openTracking(socket: FakeSocket, language = "ta") {
    const errors: SpeechProviderError[] = [];
    const provider = createDeepgramSpeechProvider({
      apiKey: "secret",
      createSocket: () => socket,
    });
    const session = provider.open({
      language,
      onInterim: () => {},
      onFinal: () => {},
      onError: (error) => errors.push(error),
      onClose: () => {},
    });
    return { session, errors };
  }

  it("reports auth for a handshake failure and network after open", () => {
    const failing = new FakeSocket();
    const beforeOpen = openTracking(failing, "hi");
    failing.onerror?.();
    assert.equal(beforeOpen.errors.length, 1);
    assert.equal(beforeOpen.errors[0]?.code, "provider_auth");
    assert.equal(beforeOpen.errors[0]?.retryable, false);

    const dropped = new FakeSocket();
    const afterOpen = openTracking(dropped, "hi");
    dropped.onopen?.();
    dropped.onerror?.();
    assert.equal(afterOpen.errors.length, 1);
    assert.equal(afterOpen.errors[0]?.code, "provider_network");
    assert.equal(afterOpen.errors[0]?.retryable, true);
  });

  it("surfaces an unexpected upstream close but stays silent on stop", () => {
    const dropped = new FakeSocket();
    const unexpected = openTracking(dropped);
    dropped.onopen?.();
    dropped.onclose?.();
    assert.equal(unexpected.errors.length, 1);
    assert.equal(unexpected.errors[0]?.code, "provider_network");

    const graceful = new FakeSocket();
    const stopped = openTracking(graceful);
    graceful.onopen?.();
    stopped.session.stop();
    graceful.onclose?.();
    assert.equal(stopped.errors.length, 0);
  });

  it("buffers audio during the handshake and flushes it in order on open", () => {
    const socket = new FakeSocket();
    const tracked = openTracking(socket);
    tracked.session.push(new Uint8Array([1, 2]));
    tracked.session.push(new Uint8Array([3]));
    assert.equal(socket.sent.length, 0);
    socket.onopen?.();
    assert.equal(socket.sent.length, 2);
    assert.deepEqual([...(socket.sent[0] as Uint8Array)], [1, 2]);
    assert.deepEqual([...(socket.sent[1] as Uint8Array)], [3]);
    assert.equal(tracked.errors.length, 0);
  });
});
