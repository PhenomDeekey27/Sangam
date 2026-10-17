import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GoogleTranslateUnofficialProvider,
  endpointLanguage,
  type GoogleProviderEvent,
} from "./google-translate-provider.js";
import { TranslationProviderError } from "./translator.js";

/**
 * Unit tests for the unofficial Google Translate primary. HTTP is fully
 * mocked — live-endpoint verification is a separate smoke test, never
 * claimed from these cases. Fixtures marked LIVE are redacted captures from
 * the real endpoints, taken with the fixed sentence "Hello, how are you?"
 * (never a user transcript).
 */

interface SeenRequest {
  readonly url: string;
  readonly init: RequestInit;
}

function mockFetch(
  seen: SeenRequest[],
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
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

function provider(
  seen: SeenRequest[],
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
  timeoutMs = 1000,
  events?: GoogleProviderEvent[],
): GoogleTranslateUnofficialProvider {
  return new GoogleTranslateUnofficialProvider({
    timeoutMs,
    fetchImpl: mockFetch(seen, respond),
    ...(events ? { onEvent: (event) => events.push(event) } : {}),
  });
}

/** LIVE shape: endpoint A plain string array. */
function listBody(translations: string[]): unknown {
  return translations;
}

/** LIVE shape: endpoint B nested rows. */
function segmentsBody(translations: string[], src = "ta"): unknown {
  return [
    translations.map((trans) => [trans, "x", null, null, 3]),
    null,
    src,
    null,
    null,
    null,
    null,
    [],
  ];
}

describe("GoogleTranslateUnofficialProvider requests", () => {
  it("translates Tamil to English with exact endpoint parameters", async () => {
    const seen: SeenRequest[] = [];
    const events: GoogleProviderEvent[] = [];
    const adapter = provider(seen, () => jsonResponse(200, listBody(["Hello brother"])), 1000, events);
    const result = await adapter.translate({
      text: "வணக்கம் அண்ணா",
      sourceLanguage: "ta",
      targetLanguage: "en",
    });
    assert.deepEqual(result, { text: "Hello brother", targetLanguage: "en" });
    assert.equal(seen.length, 1);
    const request = seen[0];
    assert.ok(request);
    assert.equal(request.init.method, "GET");
    const url = new URL(request.url);
    assert.equal(url.origin + url.pathname, "https://clients5.google.com/translate_a/t");
    assert.equal(url.searchParams.get("client"), "dict-chrome-ex");
    assert.equal(url.searchParams.get("sl"), "ta");
    assert.equal(url.searchParams.get("tl"), "en");
    assert.equal(url.searchParams.get("q"), "வணக்கம் அண்ணா");
    const headers = request.init.headers as Record<string, string>;
    assert.equal(headers["x-goog-api-key"], undefined);
    assert.ok(!request.url.includes("key"));
    // Diagnostics must mark a real extraction from the primary endpoint.
    assert.deepEqual(
      events.map((event) => event.stage),
      [
        "request_started",
        "http_status",
        "response_format",
        "translation_extracted",
      ],
    );
    assert.equal(events[2]?.stage, "response_format");
    assert.equal(
      events[2]?.stage === "response_format" ? events[2].format : null,
      "sentence_list",
    );
    assert.equal(
      events[3]?.stage === "translation_extracted" ? events[3].charCount : null,
      13,
    );
  });

  it("translates English to Tamil", async () => {
    const seen: SeenRequest[] = [];
    const adapter = provider(seen, () => jsonResponse(200, listBody(["வணக்கம்"])));
    const result = await adapter.translate({
      text: "Hello",
      sourceLanguage: "en",
      targetLanguage: "ta",
    });
    assert.deepEqual(result, { text: "வணக்கம்", targetLanguage: "ta" });
    const url = new URL(seen[0]?.url ?? "");
    assert.equal(url.searchParams.get("sl"), "en");
    assert.equal(url.searchParams.get("tl"), "ta");
  });

  it("joins multiple sentence segments in order without duplicating spaces", async () => {
    const seen: SeenRequest[] = [];
    // LIVE-captured row spacing: segments end with their own spaces.
    const adapter = provider(seen, () =>
      jsonResponse(200, segmentsBody(["காலை வணக்கம். ", "உங்கள் நாள் எப்படி இருக்கிறீர்கள்? ", "நாளை சந்திப்போம்."], "en")),
    );
    const result = await adapter.translate({
      text: "Good morning. How was your day? See you tomorrow.",
      sourceLanguage: "en",
      targetLanguage: "ta",
    });
    assert.equal(
      result.text,
      "காலை வணக்கம். உங்கள் நாள் எப்படி இருக்கிறீர்கள்? நாளை சந்திப்போம்.",
    );
  });

  it("supports the alternate single endpoint with gtx parameters", async () => {
    const seen: SeenRequest[] = [];
    const adapter = new GoogleTranslateUnofficialProvider({
      endpoint: "single",
      timeoutMs: 1000,
      fetchImpl: mockFetch(seen, () =>
        jsonResponse(200, segmentsBody(["வணக்கம், நலமா?"], "en")),
      ),
    });
    const result = await adapter.translate({
      text: "Hello, how are you?",
      sourceLanguage: "en",
      targetLanguage: "ta",
    });
    assert.deepEqual(result, { text: "வணக்கம், நலமா?", targetLanguage: "ta" });
    const url = new URL(seen[0]?.url ?? "");
    assert.equal(
      url.origin + url.pathname,
      "https://translate.googleapis.com/translate_a/single",
    );
    assert.equal(url.searchParams.get("client"), "gtx");
    assert.equal(url.searchParams.get("dt"), "t");
    assert.equal(url.searchParams.get("sl"), "en");
    assert.equal(url.searchParams.get("tl"), "ta");
  });

  it("maps Chinese to the zh-CN endpoint code", () => {
    assert.equal(endpointLanguage("zh"), "zh-CN");
    assert.equal(endpointLanguage("ta"), "ta");
    assert.equal(endpointLanguage("klingon"), null);
  });

  it("refuses unsupported languages and empty text without a request", async () => {
    const seen: SeenRequest[] = [];
    const adapter = provider(seen, () => jsonResponse(200, listBody(["x"])));
    await assert.rejects(
      adapter.translate({
        text: "வணக்கம்",
        sourceLanguage: "klingon",
        targetLanguage: "en",
      }),
      (error: unknown) =>
        error instanceof TranslationProviderError &&
        error.code === "unsupported",
    );
    await assert.rejects(
      adapter.translate({
        text: "   ",
        sourceLanguage: "ta",
        targetLanguage: "en",
      }),
      (error: unknown) =>
        error instanceof TranslationProviderError &&
        error.code === "unsupported",
    );
    assert.equal(seen.length, 0);
  });
});

describe("GoogleTranslateUnofficialProvider failures", () => {
  it("maps status codes to fallback-eligible categories", async () => {
    const cases: Array<{ status: number; code: string }> = [
      { status: 403, code: "auth" },
      { status: 429, code: "rate_limited" },
      { status: 500, code: "network" },
      { status: 503, code: "network" },
    ];
    for (const { status, code } of cases) {
      const seen: SeenRequest[] = [];
      const adapter = provider(seen, () =>
        jsonResponse(status, { error: "nope" }),
      );
      await assert.rejects(
        adapter.translate({
          text: "வணக்கம்",
          sourceLanguage: "ta",
          targetLanguage: "en",
        }),
        (error: unknown) => {
          assert.ok(error instanceof TranslationProviderError);
          assert.equal(error.code, code);
          assert.equal(error.httpStatus, status);
          return true;
        },
      );
    }
  });

  it("rejects malformed, empty, and unexpected 200 bodies", async () => {
    const bodies: unknown[] = [
      { sentences: [{ trans: "  " }], src: "ta" },
      { sentences: [], src: "ta" },
      { sentences: [42], src: "ta" },
      { src: "ta" },
      [],
      ["   "],
      [42, "mixed"],
      [[null, "row without translation"]],
      "not-an-object",
      42,
    ];
    for (const body of bodies) {
      const seen: SeenRequest[] = [];
      const adapter = provider(seen, () => jsonResponse(200, body));
      await assert.rejects(
        adapter.translate({
          text: "வணக்கம்",
          sourceLanguage: "ta",
          targetLanguage: "en",
        }),
        (error: unknown) => {
          assert.ok(error instanceof TranslationProviderError);
          assert.equal(error.code, "unknown");
          assert.match(error.message, /rejected/);
          return true;
        },
      );
    }
    const malformed: SeenRequest[] = [];
    const badJson = provider(
      malformed,
      () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("bad json");
          },
          text: async () => "not json",
        }) as unknown as Response,
    );
    await assert.rejects(
      badJson.translate({
        text: "வணக்கம்",
        sourceLanguage: "ta",
        targetLanguage: "en",
      }),
      (error: unknown) =>
        error instanceof TranslationProviderError && error.code === "unknown",
    );
  });

  it("rejects an echo only when the reported source disagrees", async () => {
    const echoed: SeenRequest[] = [];
    // LIVE-fixture shape: identical output while the endpoint claims it
    // translated from a different source — a block page shaped like success.
    const mismatch = provider(echoed, () =>
      jsonResponse(200, segmentsBody(["வணக்கம்"], "en")),
    );
    await assert.rejects(
      mismatch.translate({
        text: "வணக்கம்",
        sourceLanguage: "ta",
        targetLanguage: "en",
      }),
      (error: unknown) => {
        assert.ok(error instanceof TranslationProviderError);
        assert.equal(error.code, "unknown");
        assert.match(error.message, /echoed the source text/);
        return true;
      },
    );

    // Identical text is valid for names: reported source agrees, so accept.
    const named: SeenRequest[] = [];
    const same = provider(named, () =>
      jsonResponse(200, segmentsBody(["Stalin"], "en")),
    );
    const result = await same.translate({
      text: "Stalin",
      sourceLanguage: "en",
      targetLanguage: "ta",
    });
    assert.equal(result.text, "Stalin");
  });

  it("accepts a name echo on the plain-array endpoint (no metadata)", async () => {
    // LIVE shape: endpoint A returns only `["<text>"]` with no `src`; an
    // identical passthrough for a name is legitimate and cannot be
    // distinguished from an echo, so it is accepted as-is.
    const seen: SeenRequest[] = [];
    const adapter = provider(seen, () => jsonResponse(200, listBody(["வணக்கம்"])));
    const result = await adapter.translate({
      text: "வணக்கம்",
      sourceLanguage: "en",
      targetLanguage: "ta",
    });
    assert.equal(result.text, "வணக்கம்");
  });

  it("maps a hung endpoint to a timeout", async () => {
    const adapter = new GoogleTranslateUnofficialProvider({
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
    await assert.rejects(
      adapter.translate({
        text: "வணக்கம்",
        sourceLanguage: "ta",
        targetLanguage: "en",
      }),
      (error: unknown) =>
        error instanceof TranslationProviderError && error.code === "timeout",
    );
  });
});
