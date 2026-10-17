import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SARVAM_DEFAULT_TRANSLATION_MODEL,
  SARVAM_TRANSLATE_ENDPOINT,
  SarvamTranslator,
  readTranslatedText,
  toTranslationError,
} from "./sarvam-provider.js";
import {
  createTranslationChain,
  type ChainAttemptInfo,
  type ChainMember,
} from "./translation-chain.js";
import {
  TranslationProviderError,
  type TranslationRequest,
  type Translator,
} from "./translator.js";
import { MockTranslator } from "./mock-translator.js";

/** Unit tests for Sarvam Mayura and the Sarvam → Google → Gemini chain. */

interface SeenRequest {
  readonly url: string;
  readonly init: RequestInit;
}

function mockFetch(
  seen: SeenRequest[],
  respond: () => Response,
): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const REQUEST: TranslationRequest = {
  text: "வணக்கம்",
  sourceLanguage: "ta",
  targetLanguage: "hi",
};

describe("SarvamTranslator requests", () => {
  it("posts the documented body with regional codes and the key header", async () => {
    const seen: SeenRequest[] = [];
    const translator = new SarvamTranslator({
      apiKey: "sarvam-secret",
      fetchImpl: mockFetch(seen, () =>
        jsonResponse(200, { translated_text: "नमस्ते", source_language_code: "ta-IN" }),
      ),
    });
    const result = await translator.translate(REQUEST);

    assert.deepEqual(result, { text: "नमस्ते", targetLanguage: "hi" });
    assert.equal(seen[0]?.url, SARVAM_TRANSLATE_ENDPOINT);
    const headers = seen[0]?.init.headers as Record<string, string>;
    assert.equal(headers["api-subscription-key"], "sarvam-secret");
    assert.equal(headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(String(seen[0]?.init.body)), {
      input: "வணக்கம்",
      source_language_code: "ta-IN",
      target_language_code: "hi-IN",
      model: SARVAM_DEFAULT_TRANSLATION_MODEL,
    });
  });

  it("refuses a non-Indic pair locally without a network call", async () => {
    const seen: SeenRequest[] = [];
    const translator = new SarvamTranslator({
      apiKey: "k",
      fetchImpl: mockFetch(seen, () => jsonResponse(200, {})),
    });
    await assert.rejects(
      translator.translate({ text: "Bonjour", sourceLanguage: "fr", targetLanguage: "es" }),
      (error: unknown) => {
        assert.ok(error instanceof TranslationProviderError);
        assert.equal(error.code, "unsupported");
        return true;
      },
    );
    assert.equal(seen.length, 0);
  });

  it("refuses empty text without a network call", async () => {
    const seen: SeenRequest[] = [];
    const translator = new SarvamTranslator({
      apiKey: "k",
      fetchImpl: mockFetch(seen, () => jsonResponse(200, {})),
    });
    await assert.rejects(
      translator.translate({ text: "   ", sourceLanguage: "ta", targetLanguage: "hi" }),
      /untranslatable/,
    );
    assert.equal(seen.length, 0);
  });

  it("treats an unusable response as unknown", async () => {
    const translator = new SarvamTranslator({
      apiKey: "k",
      fetchImpl: mockFetch([], () => jsonResponse(200, { nope: true })),
    });
    await assert.rejects(translator.translate(REQUEST), /no usable text/);
  });

  it("classifies every documented failure kind", () => {
    const kinds = [
      ["auth", "auth"],
      ["rate_limited", "rate_limited"],
      ["timeout", "timeout"],
      ["rejected", "unsupported"],
      ["malformed", "unknown"],
      ["server", "network"],
      ["network", "network"],
    ] as const;
    for (const [kind, code] of kinds) {
      const error = toTranslationError({ kind, status: null, detail: "", quota: false });
      assert.equal(error.code, code, `kind ${kind}`);
    }
  });

  it("validates the documented response shape", () => {
    assert.equal(readTranslatedText({ translated_text: " hi " }), "hi");
    assert.equal(readTranslatedText({}), null);
    assert.equal(readTranslatedText(null), null);
  });
});

/** Scriptable translator with a call counter and a chosen failure. */
class FakeTranslator implements Translator {
  readonly calls: TranslationRequest[] = [];
  constructor(
    private readonly behavior: (
      request: TranslationRequest,
    ) => Promise<{ text: string; targetLanguage: string }>,
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

function failWith(code: "timeout" | "network" | "unsupported" | "auth") {
  return async () => {
    throw new TranslationProviderError(code, `fake ${code}`);
  };
}

function chain(
  members: readonly ChainMember[],
  attempts: ChainAttemptInfo[] = [],
): Translator {
  return createTranslationChain({
    members,
    onAttempt: (info) => attempts.push(info),
  });
}

describe("Sarvam → Google → Gemini translation chain", () => {
  const request: TranslationRequest = {
    text: "வணக்கம்",
    sourceLanguage: "ta",
    targetLanguage: "en",
  };

  it("returns the Sarvam result without touching the fallbacks", async () => {
    const sarvam = new FakeTranslator(succeed("Hello"));
    const google = new FakeTranslator(succeed("g"));
    const gemini = new MockTranslator();
    const attempts: ChainAttemptInfo[] = [];
    const result = await chain(
      [
        { id: "sarvam", translator: sarvam, stopOnUnsupported: false },
        { id: "google", translator: google, stopOnUnsupported: true },
        { id: "gemini", translator: gemini, stopOnUnsupported: true },
      ],
      attempts,
    ).translate(request);

    assert.equal(result.text, "Hello");
    assert.equal(google.calls.length, 0);
    assert.equal(gemini.calls.length, 0);
    assert.deepEqual(attempts.map((a) => [a.provider, a.ok]), [["sarvam", true]]);
  });

  it("falls through Sarvam's unsupported gap to Google", async () => {
    const sarvam = new FakeTranslator(failWith("unsupported"));
    const google = new FakeTranslator(succeed("Hello from Google"));
    const attempts: ChainAttemptInfo[] = [];
    const result = await chain(
      [
        { id: "sarvam", translator: sarvam, stopOnUnsupported: false },
        { id: "google", translator: google, stopOnUnsupported: true },
      ],
      attempts,
    ).translate(request);

    assert.equal(result.text, "Hello from Google");
    assert.deepEqual(attempts.map((a) => [a.provider, a.ok]), [
      ["sarvam", false],
      ["google", true],
    ]);
  });

  it("falls through Sarvam's outage to Google, then Gemini", async () => {
    const sarvam = new FakeTranslator(failWith("network"));
    const google = new FakeTranslator(failWith("timeout"));
    const gemini = new FakeTranslator(succeed("Hello from Gemini"));
    const finals: string[] = [];
    const translator = createTranslationChain({
      members: [
        { id: "sarvam", translator: sarvam, stopOnUnsupported: false },
        { id: "google", translator: google, stopOnUnsupported: true },
        { id: "gemini", translator: gemini, stopOnUnsupported: true },
      ],
      onFinal: (info) => finals.push(info.provider),
    });
    const result = await translator.translate(request);

    assert.equal(result.text, "Hello from Gemini");
    assert.equal(sarvam.calls.length, 1);
    assert.equal(google.calls.length, 1);
    assert.equal(gemini.calls.length, 1);
    assert.deepEqual(finals, ["gemini"]);
  });

  it("still aborts on Google's unsupported pair (Gemini shares its mapping)", async () => {
    const google = new FakeTranslator(failWith("unsupported"));
    const gemini = new FakeTranslator(succeed("nope"));
    const translator = createTranslationChain({
      members: [
        { id: "google", translator: google, stopOnUnsupported: true },
        { id: "gemini", translator: gemini, stopOnUnsupported: true },
      ],
    });
    await assert.rejects(translator.translate(request), (error: unknown) => {
      assert.ok(error instanceof TranslationProviderError);
      assert.equal(error.code, "unsupported");
      return true;
    });
    assert.equal(gemini.calls.length, 0);
  });

  it("returns a single member untouched", () => {
    const only = new FakeTranslator(succeed("x"));
    const built = createTranslationChain({
      members: [{ id: "google", translator: only }],
    });
    assert.equal(built, only);
  });

  it("throws the last member's error when every provider fails", async () => {
    const translator = chain([
      { id: "sarvam", translator: new FakeTranslator(failWith("network")), stopOnUnsupported: false },
      { id: "google", translator: new FakeTranslator(failWith("network")), stopOnUnsupported: true },
      { id: "gemini", translator: new FakeTranslator(failWith("auth")), stopOnUnsupported: true },
    ]);
    await assert.rejects(translator.translate(request), (error: unknown) => {
      assert.ok(error instanceof TranslationProviderError);
      assert.equal(error.code, "auth");
      return true;
    });
  });
});
