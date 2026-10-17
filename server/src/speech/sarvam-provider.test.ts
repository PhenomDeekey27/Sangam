import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SARVAM_DEFAULT_STT_MODEL,
  SARVAM_STT_ENDPOINT,
  createSarvamSpeechProvider,
  readTranscript,
  sarvamSttFilename,
  toSpeechProviderError,
} from "./sarvam-provider.js";
import type {
  SpeechProvider,
  SpeechProviderError,
  SpeechProviderSession,
} from "./provider.js";
import type { SarvamFailure } from "../sarvam/http.js";

/**
 * Unit tests for the Sarvam Saaras adapter. HTTP is fully mocked — no request
 * touches the network. Success, every documented failure class, and the
 * one-shot Deepgram replay are covered; live speech is out of scope here.
 */

type CapturedFinal = { text: string; detectedLanguage: string | null };

interface Captured {
  readonly finals: CapturedFinal[];
  readonly errors: SpeechProviderError[];
  readonly interims: string[];
}

interface SeenRequest {
  readonly url: string;
  readonly init: RequestInit;
}

function mockFetch(
  seen: SeenRequest[],
  respond: (init: RequestInit) => Response,
): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return respond(init ?? {});
  }) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function badJsonResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => {
      throw new SyntaxError("not json");
    },
  } as unknown as Response;
}

function captured(): Captured {
  return { finals: [], errors: [], interims: [] };
}

function open(
  provider: SpeechProvider,
  language: string,
  sink: Captured,
  mimeType?: string,
): SpeechProviderSession {
  return provider.open({
    language,
    mimeType,
    onInterim: (text) => sink.interims.push(text),
    onFinal: (text, metadata) =>
      sink.finals.push({
        text,
        detectedLanguage: metadata?.detectedLanguage ?? null,
      }),
    onError: (error) => sink.errors.push(error),
    onClose: () => {},
  });
}

function flush(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CHUNK = new Uint8Array([1, 2, 3, 4]);

describe("Sarvam STT multipart requests", () => {
  it("uploads the buffered turn with the documented fields and key header", async () => {
    const seen: SeenRequest[] = [];
    const provider = createSarvamSpeechProvider({
      apiKey: "sarvam-secret",
      fetchImpl: mockFetch(seen, () =>
        jsonResponse(200, {
          request_id: "r-1",
          transcript: "नमस्ते",
          language_code: "hi-IN",
          language_probability: 0.93,
        }),
      ),
    });
    const sink = captured();
    const session = open(provider, "hi", sink, "audio/webm;codecs=opus");
    session.push(CHUNK);
    session.stop();
    await flush();

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.url, SARVAM_STT_ENDPOINT);
    const headers = seen[0]?.init.headers as Record<string, string>;
    assert.equal(headers["api-subscription-key"], "sarvam-secret");
    const form = seen[0]?.init.body as FormData;
    assert.ok(form instanceof FormData);
    assert.equal(form.get("model"), SARVAM_DEFAULT_STT_MODEL);
    assert.equal(form.get("language_code"), "hi-IN");
    const file = form.get("file") as File;
    assert.equal(file.name, "turn.webm");
    assert.deepEqual(sink.finals, [
      { text: "नमस्ते", detectedLanguage: "hi" },
    ]);
    assert.deepEqual(sink.errors, []);
  });

  it("uploads nothing for a turn with no captured audio", async () => {
    const seen: SeenRequest[] = [];
    const provider = createSarvamSpeechProvider({
      apiKey: "k",
      fetchImpl: mockFetch(seen, () => jsonResponse(200, { transcript: "x" })),
    });
    const sink = captured();
    open(provider, "ta", sink).stop();
    await flush();
    assert.equal(seen.length, 0);
    assert.deepEqual(sink.finals, []);
  });

  it("treats an empty transcript as silence (no final)", async () => {
    const provider = createSarvamSpeechProvider({
      apiKey: "k",
      fetchImpl: mockFetch([], () =>
        jsonResponse(200, { transcript: "   ", language_code: "ta-IN" }),
      ),
    });
    const sink = captured();
    const session = open(provider, "ta", sink);
    session.push(CHUNK);
    session.stop();
    await flush();
    assert.deepEqual(sink.finals, []);
    assert.deepEqual(sink.errors, []);
  });

  it("never fails the provider when the upload is aborted on close", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const provider = createSarvamSpeechProvider({
      apiKey: "k",
      fetchImpl: mockFetch([], () => {
        // A response object whose JSON resolves only after `close()`.
        return {
          ok: true,
          status: 200,
          json: () =>
            new Promise((resolve) => {
              gate.release = () => resolve({ transcript: "late" });
            }),
        } as unknown as Response;
      }),
    });
    const sink = captured();
    const session = open(provider, "ta", sink);
    session.push(CHUNK);
    session.stop();
    session.close();
    gate.release?.();
    await flush();
    assert.deepEqual(sink.finals, []);
    assert.deepEqual(sink.errors, []);
  });
});

describe("Sarvam STT failure mapping", () => {
  const cases: ReadonlyArray<{
    readonly label: string;
    readonly response: () => Response;
    readonly code: string;
  }> = [
    { label: "401", response: () => jsonResponse(401, {}), code: "provider_auth" },
    { label: "429", response: () => jsonResponse(429, {}), code: "provider_quota" },
    { label: "400", response: () => jsonResponse(400, {}), code: "provider_response" },
    { label: "500", response: () => jsonResponse(500, {}), code: "provider_network" },
    { label: "non-json", response: () => badJsonResponse(400), code: "provider_response" },
  ];

  for (const testCase of cases) {
    it(`maps an HTTP ${testCase.label} failure to ${testCase.code}`, async () => {
      const provider = createSarvamSpeechProvider({
        apiKey: "k",
        fetchImpl: mockFetch([], testCase.response),
      });
      const sink = captured();
      const session = open(provider, "ta", sink);
      session.push(CHUNK);
      session.stop();
      await flush();
      assert.equal(sink.errors.length, 1);
      assert.equal(sink.errors[0]?.code, testCase.code);
      assert.deepEqual(sink.finals, []);
    });
  }

  it("maps a network rejection to provider_network", async () => {
    const provider = createSarvamSpeechProvider({
      apiKey: "k",
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    const sink = captured();
    const session = open(provider, "ta", sink);
    session.push(CHUNK);
    session.stop();
    await flush();
    assert.equal(sink.errors[0]?.code, "provider_network");
  });

  it("maps a 200 with an undocumented shape to provider_response", async () => {
    const provider = createSarvamSpeechProvider({
      apiKey: "k",
      fetchImpl: mockFetch([], () => jsonResponse(200, { nope: true })),
    });
    const sink = captured();
    const session = open(provider, "ta", sink);
    session.push(CHUNK);
    session.stop();
    await flush();
    assert.equal(sink.errors[0]?.code, "provider_response");
  });

  it("classifies every documented failure kind", () => {
    const kinds: ReadonlyArray<[SarvamFailure["kind"], string]> = [
      ["auth", "provider_auth"],
      ["rate_limited", "provider_quota"],
      ["rejected", "provider_response"],
      ["malformed", "provider_response"],
      ["timeout", "provider_network"],
      ["server", "provider_network"],
      ["network", "provider_network"],
    ];
    for (const [kind, code] of kinds) {
      const error = toSpeechProviderError({ kind, status: null, detail: "", quota: false });
      assert.equal(error.code, code, `kind ${kind}`);
    }
  });
});

describe("Sarvam STT Deepgram replay fallback", () => {
  /** A minimal recording speech provider used as the injected fallback. */
  function fallbackProvider(
    languages: readonly string[],
    sink: Captured,
    chunks: Uint8Array[],
  ): SpeechProvider {
    return {
      id: "deepgram",
      streaming: true,
      interim: true,
      languages,
      open(options) {
        return {
          push(chunk) {
            chunks.push(chunk);
            options.onInterim("should-be-suppressed");
          },
          stop() {
            options.onFinal("Hello fallback", {
              detectedLanguage: "en",
              confidence: 0.8,
            });
          },
          close() {},
        };
      },
    };
  }

  it("replays the buffered turn once when Sarvam fails", async () => {
    const chunks: Uint8Array[] = [];
    const fallbackSink = captured();
    const provider = createSarvamSpeechProvider({
      apiKey: "k",
      fetchImpl: mockFetch([], () => jsonResponse(503, {})),
      fallback: fallbackProvider(["ta"], fallbackSink, chunks),
    });
    const sink = captured();
    const session = open(provider, "ta", sink, "audio/webm");
    session.push(CHUNK);
    session.push(CHUNK);
    session.stop();
    await flush();

    assert.equal(chunks.length, 2);
    assert.deepEqual(sink.finals, [
      { text: "Hello fallback", detectedLanguage: "en" },
    ]);
    assert.deepEqual(sink.errors, []);
    // Replayed audio never produces a late interim line.
    assert.deepEqual(sink.interims, []);
  });

  it("does not replay into a fallback that refuses the language", async () => {
    const provider = createSarvamSpeechProvider({
      apiKey: "k",
      fetchImpl: mockFetch([], () => jsonResponse(503, {})),
      fallback: fallbackProvider(["en"], captured(), []),
    });
    const sink = captured();
    const session = open(provider, "ta", sink);
    session.push(CHUNK);
    session.stop();
    await flush();
    assert.deepEqual(sink.finals, []);
    assert.equal(sink.errors[0]?.code, "provider_network");
  });
});

describe("Sarvam STT helpers", () => {
  it("maps MIME types to documented upload filenames", () => {
    assert.equal(sarvamSttFilename("audio/webm;codecs=opus"), "turn.webm");
    assert.equal(sarvamSttFilename("audio/ogg"), "turn.ogg");
    assert.equal(sarvamSttFilename("audio/mp4"), "turn.mp4");
    assert.equal(sarvamSttFilename("audio/mpeg"), "turn.mp3");
    assert.equal(sarvamSttFilename("audio/wav"), "turn.wav");
    assert.equal(sarvamSttFilename(undefined), "turn.webm");
  });

  it("validates the documented transcript response", () => {
    assert.deepEqual(readTranscript({ transcript: " hi ", language_code: "hi-IN" }), {
      transcript: "hi",
      languageCode: "hi-IN",
      languageProbability: null,
    });
    assert.equal(readTranscript({ nope: 1 }), null);
    assert.equal(readTranscript(null), null);
    assert.equal(readTranscript("x"), null);
  });
});
