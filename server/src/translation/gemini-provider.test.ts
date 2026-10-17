import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GeminiTranslator,
  languageName,
  type GeminiTranslatorOptions,
} from "./gemini-provider.js";
import { TranslationProviderError } from "./translator.js";

/**
 * Unit tests for the Gemini translation adapter. HTTP is fully mocked — no
 * request here touches the network. Anything asserting real-vendor behavior
 * is marked LIVE and runs only with credentials (see the Stage 5 report).
 */

const API_KEY = "SECRET-KEY-XYZ";

interface SeenRequest {
  readonly url: string;
  readonly init: RequestInit;
}

function mockFetch(
  seen: SeenRequest[],
  respond: (url: string, init: RequestInit) => Response,
): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return respond(String(url), init ?? {});
  }) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function successBody(text: string): unknown {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
  };
}

function translator(
  seen: SeenRequest[],
  respond: (url: string, init: RequestInit) => Response,
  extra?: Partial<GeminiTranslatorOptions>,
): GeminiTranslator {
  return new GeminiTranslator({
    apiKey: API_KEY,
    fetchImpl: mockFetch(seen, respond),
    ...extra,
  });
}

function requestBody(seen: SeenRequest[]): Record<string, unknown> {
  return JSON.parse(String(seen[0]?.init.body)) as Record<string, unknown>;
}

describe("GeminiTranslator language names", () => {
  it("names the demo pairs correctly in prompts", () => {
    assert.equal(languageName("fr"), "French");
    assert.equal(languageName("pa"), "Punjabi");
    assert.equal(languageName("ta"), "Tamil");
    assert.equal(languageName("en"), "English");
    assert.equal(languageName("FR"), "French");
    assert.equal(languageName("klingon"), null);
    assert.equal(languageName(""), null);
  });
});

describe("GeminiTranslator requests", () => {
  it("translates French to Punjabi through gemini-3.5-flash-lite", async () => {
    const seen: SeenRequest[] = [];
    const adapter = translator(seen, () =>
      jsonResponse(200, successBody("ਸਤ ਸ੍ਰੀ ਅਕਾਲ")),
    );
    const result = await adapter.translate({
      text: "Bonjour",
      sourceLanguage: "fr",
      targetLanguage: "pa",
    });
    assert.deepEqual(result, {
      text: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ",
      targetLanguage: "pa",
    });
    assert.equal(seen.length, 1);
    const request = seen[0];
    assert.ok(request);
    assert.equal(
      request.url,
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
    );
    assert.equal(request.init.method, "POST");
    const headers = request.init.headers as Record<string, string>;
    assert.equal(headers["x-goog-api-key"], API_KEY);
    const body = requestBody(seen);
    assert.deepEqual(body.contents, [
      { role: "user", parts: [{ text: "Bonjour" }] },
    ]);
    const systemText = (
      body.system_instruction as {
        parts: Array<{ text: string }>;
      }
    ).parts[0]?.text;
    assert.ok(systemText?.includes("French"));
    assert.ok(systemText?.includes("Punjabi"));
    assert.ok(systemText?.includes("only the translated text"));
    assert.equal(
      (body.generationConfig as { maxOutputTokens: number }).maxOutputTokens,
      512,
    );
  });

  it("translates Punjabi to French", async () => {
    const seen: SeenRequest[] = [];
    const adapter = translator(seen, () =>
      jsonResponse(200, successBody("Bonjour")),
    );
    const result = await adapter.translate({
      text: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ",
      sourceLanguage: "pa",
      targetLanguage: "fr",
    });
    assert.deepEqual(result, { text: "Bonjour", targetLanguage: "fr" });
    const systemText = (
      requestBody(seen).system_instruction as {
        parts: Array<{ text: string }>;
      }
    ).parts[0]?.text;
    assert.ok(systemText?.includes("Punjabi"));
    assert.ok(systemText?.includes("French"));
  });

  it("translates Tamil to English and back", async () => {
    const seenTaEn: SeenRequest[] = [];
    const taEn = await translator(seenTaEn, () =>
      jsonResponse(200, successBody("Good morning")),
    ).translate({
      text: "காலை வணக்கம்",
      sourceLanguage: "ta",
      targetLanguage: "en",
    });
    assert.deepEqual(taEn, { text: "Good morning", targetLanguage: "en" });
    const taPrompt = (
      requestBody(seenTaEn).system_instruction as {
        parts: Array<{ text: string }>;
      }
    ).parts[0]?.text;
    assert.ok(taPrompt?.includes("Tamil"));
    assert.ok(taPrompt?.includes("English"));

    const seenEnTa: SeenRequest[] = [];
    const enTa = await translator(seenEnTa, () =>
      jsonResponse(200, successBody("காலை வணக்கம்")),
    ).translate({
      text: "Good morning",
      sourceLanguage: "en",
      targetLanguage: "ta",
    });
    assert.deepEqual(enTa, { text: "காலை வணக்கம்", targetLanguage: "ta" });
  });

  it("joins multi-part responses and honors a custom model", async () => {
    const seen: SeenRequest[] = [];
    const adapter = translator(
      seen,
      () =>
        jsonResponse(200, {
          candidates: [
            {
              content: { parts: [{ text: "ਸਤ " }, { text: "ਸ੍ਰੀ ਅਕਾਲ" }] },
              finishReason: "STOP",
            },
          ],
        }),
      { model: "gemini-3.5-flash-lite-custom" },
    );
    const result = await adapter.translate({
      text: "Bonjour",
      sourceLanguage: "fr",
      targetLanguage: "pa",
    });
    assert.equal(result.text, "ਸਤ ਸ੍ਰੀ ਅਕਾਲ");
    assert.ok(
      seen[0]?.url.includes(
        "models/gemini-3.5-flash-lite-custom:generateContent",
      ),
    );
  });

  it("refuses invalid languages and empty text without calling the network", async () => {
    const seen: SeenRequest[] = [];
    const adapter = translator(seen, () => jsonResponse(200, successBody("x")));
    await assert.rejects(
      adapter.translate({
        text: "Bonjour",
        sourceLanguage: "klingon",
        targetLanguage: "pa",
      }),
      (error: unknown) =>
        error instanceof TranslationProviderError &&
        error.code === "unsupported",
    );
    await assert.rejects(
      adapter.translate({
        text: "   ",
        sourceLanguage: "fr",
        targetLanguage: "pa",
      }),
      (error: unknown) =>
        error instanceof TranslationProviderError &&
        error.code === "unsupported",
    );
    assert.equal(seen.length, 0);
  });
});

describe("GeminiTranslator failures", () => {
  it("maps status codes without leaking the key", async () => {
    const cases: Array<{ status: number; code: string }> = [
      { status: 400, code: "unsupported" },
      { status: 401, code: "auth" },
      { status: 403, code: "auth" },
      { status: 404, code: "unknown" },
      { status: 429, code: "rate_limited" },
      { status: 500, code: "network" },
      { status: 503, code: "network" },
    ];
    for (const { status, code } of cases) {
      const seen: SeenRequest[] = [];
      const adapter = translator(seen, () =>
        jsonResponse(status, { error: { code: status, message: "nope" } }),
      );
      await assert.rejects(
        adapter.translate({
          text: "Bonjour",
          sourceLanguage: "fr",
          targetLanguage: "pa",
        }),
        (error: unknown) => {
          assert.ok(error instanceof TranslationProviderError);
          assert.equal(error.code, code);
          assert.equal(error.message.includes(API_KEY), false);
          return true;
        },
      );
    }
  });

  it("maps empty, blocked, and malformed responses without the key", async () => {
    const bodies: unknown[] = [
      { candidates: [] },
      { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] },
      {
        candidates: [
          { content: { parts: [{ text: "  " }] }, finishReason: "STOP" },
        ],
      },
      {
        promptFeedback: { blockReason: "SAFETY" },
        candidates: [],
      },
      {
        candidates: [
          {
            content: { parts: [{ text: "Bonjour" }] },
            finishReason: "SAFETY",
          },
        ],
      },
      "not-an-object",
    ];
    for (const body of bodies) {
      const seen: SeenRequest[] = [];
      const adapter = translator(seen, () => jsonResponse(200, body));
      await assert.rejects(
        adapter.translate({
          text: "Bonjour",
          sourceLanguage: "fr",
          targetLanguage: "pa",
        }),
        (error: unknown) => {
          assert.ok(error instanceof TranslationProviderError);
          assert.equal(error.code, "unknown");
          assert.equal(error.message.includes(API_KEY), false);
          return true;
        },
      );
    }
  });

  it("maps a hung provider to a timeout", async () => {
    const adapter = hangingTranslator();
    await assert.rejects(
      adapter.translate({
        text: "Bonjour",
        sourceLanguage: "fr",
        targetLanguage: "pa",
      }),
      (error: unknown) => {
        assert.ok(error instanceof TranslationProviderError);
        assert.equal(error.code, "timeout");
        assert.equal(error.message.includes(API_KEY), false);
        return true;
      },
    );
  });

  it("retries once after a timeout and then succeeds", async () => {
    let calls = 0;
    const adapter = new GeminiTranslator({
      apiKey: API_KEY,
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) {
          const failure = new Error("aborted");
          failure.name = "AbortError";
          throw failure;
        }
        return jsonResponse(200, successBody("Bonjour"));
      }) as typeof fetch,
    });
    const result = await adapter.translate({
      text: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ",
      sourceLanguage: "pa",
      targetLanguage: "fr",
    });
    assert.deepEqual(result, { text: "Bonjour", targetLanguage: "fr" });
    assert.equal(calls, 2);
  });

  it("does not retry auth failures", async () => {
    const seen: SeenRequest[] = [];
    const adapter = translator(seen, () =>
      jsonResponse(401, { error: { code: 401, message: "nope" } }),
    );
    await assert.rejects(
      adapter.translate({
        text: "Bonjour",
        sourceLanguage: "fr",
        targetLanguage: "pa",
      }),
      (error: unknown) =>
        error instanceof TranslationProviderError && error.code === "auth",
    );
    assert.equal(seen.length, 1);
  });

  it("maps a plain Error named AbortError to a timeout", async () => {
    const seen: SeenRequest[] = [];
    const adapter = translator(
      seen,
      () => jsonResponse(200, successBody("x")),
      {
        timeoutMs: 30,
        fetchImpl: (async () => {
          const failure = new Error("aborted");
          failure.name = "AbortError";
          throw failure;
        }) as typeof fetch,
      },
    );
    await assert.rejects(
      adapter.translate({
        text: "Bonjour",
        sourceLanguage: "fr",
        targetLanguage: "pa",
      }),
      (error: unknown) => {
        assert.ok(error instanceof TranslationProviderError);
        assert.equal(error.code, "timeout");
        return true;
      },
    );
  });
});

function hangingTranslator(): GeminiTranslator {
  return new GeminiTranslator({
    apiKey: API_KEY,
    timeoutMs: 30,
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }) as typeof fetch,
  });
}
