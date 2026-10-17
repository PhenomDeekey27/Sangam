import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GeminiTtsProvider } from "./gemini-tts-provider.js";
import { TtsProviderError } from "./provider.js";

/** Build a documented Interactions-API success body for one audio output. */
function interactionsResponse(wav: Buffer): unknown {
  return {
    steps: [
      {
        type: "other_step",
        content: [{ type: "text", text: "ignored" }],
      },
      {
        type: "model_output",
        content: [{ type: "audio", data: wav.toString("base64") }],
      },
    ],
  };
}

/** A fetch stub that answers every call with the given status/body. */
function stubFetch(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
): typeof fetch & { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(handler(String(url), init ?? {}));
  }) as typeof fetch & { calls: typeof calls };
  impl.calls = calls;
  return impl;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GeminiTtsProvider", () => {
  const request = { text: "Bonjour", language: "fr" };

  it("synthesizes a WAV from the last audio step and keeps the key in headers", async () => {
    const wav = Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
    const fetchImpl = stubFetch((url, init) => {
      assert.equal(
        url,
        "https://generativelanguage.googleapis.com/v1beta/interactions",
      );
      const headers = init.headers as Record<string, string>;
      assert.equal(headers["x-goog-api-key"], "test-key");
      assert.ok(!String(headers.authorization ?? ""), "no bearer header");
      return jsonResponse(200, interactionsResponse(wav));
    });
    const provider = new GeminiTtsProvider({
      apiKey: "test-key",
      fetchImpl,
      timeoutMs: 1000,
    });

    const result = await provider.synthesize(request);
    assert.equal(result.mimeType, "audio/wav");
    assert.deepEqual([...result.audio], [...wav]);
    assert.equal(fetchImpl.calls.length, 1);
    const body = JSON.parse(String(fetchImpl.calls[0]?.init.body)) as {
      model: string;
      response_format: { type: string };
      generation_config: { speech_config: { voice: string }[] };
    };
    assert.equal(body.model, "gemini-3.8-flash-lite-tts");
    assert.equal(body.response_format.type, "audio");
    assert.equal(body.generation_config.speech_config[0]?.voice, "Kore");
  });

  it("rejects an empty or oversized text without calling the provider", async () => {
    const fetchImpl = stubFetch(() => jsonResponse(500, {}));
    const provider = new GeminiTtsProvider({
      apiKey: "k",
      fetchImpl,
      timeoutMs: 1000,
    });
    await assert.rejects(
      provider.synthesize({ text: "   ", language: "en" }),
      (error: TtsProviderError) => error.code === "unsupported",
    );
    await assert.rejects(
      provider.synthesize({ text: "x".repeat(1001), language: "en" }),
      (error: TtsProviderError) => error.code === "unsupported",
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it("maps provider statuses onto safe failure codes", async () => {
    const cases: {
      status: number;
      code: TtsProviderError["code"];
    }[] = [
      { status: 429, code: "rate_limited" },
      { status: 401, code: "auth" },
      { status: 403, code: "auth" },
      { status: 400, code: "unsupported" },
      { status: 404, code: "unknown" },
      { status: 500, code: "network" },
    ];
    for (const { status, code } of cases) {
      const fetchImpl = stubFetch(() => jsonResponse(status, { error: "x" }));
      const provider = new GeminiTtsProvider({
        apiKey: "k",
        fetchImpl,
        timeoutMs: 1000,
      });
      await assert.rejects(provider.synthesize(request), (error: TtsProviderError) => {
        assert.equal(error.code, code);
        assert.equal(error.httpStatus, status);
        return true;
      });
    }
  });

  it("marks a response without audio as unknown", async () => {
    const fetchImpl = stubFetch(() =>
      jsonResponse(200, { steps: [{ type: "model_output", content: [] }] }),
    );
    const provider = new GeminiTtsProvider({
      apiKey: "k",
      fetchImpl,
      timeoutMs: 1000,
    });
    await assert.rejects(provider.synthesize(request), (error: TtsProviderError) => {
      assert.equal(error.code, "unknown");
      return true;
    });
  });

  it("reports a timeout when the provider never answers", async () => {
    const fetchImpl = ((
      _url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      })) as unknown as typeof fetch;
    const provider = new GeminiTtsProvider({
      apiKey: "k",
      fetchImpl,
      timeoutMs: 20,
    });
    await assert.rejects(provider.synthesize(request), (error: TtsProviderError) => {
      assert.equal(error.code, "timeout");
      return true;
    });
  });

  it("retries once on a network blip before failing", async () => {
    let calls = 0;
    const fetchImpl = stubFetch(() => {
      calls += 1;
      if (calls === 1) throw new TypeError("failed to fetch");
      return jsonResponse(200, interactionsResponse(Buffer.from("ok")));
    });
    const provider = new GeminiTtsProvider({
      apiKey: "k",
      fetchImpl,
      timeoutMs: 1000,
    });
    const result = await provider.synthesize(request);
    assert.equal(calls, 2);
    assert.equal(result.audio.toString("ascii"), "ok");
  });
});
