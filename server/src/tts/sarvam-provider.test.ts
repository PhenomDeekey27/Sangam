import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SARVAM_DEFAULT_TTS_MODEL,
  SARVAM_TTS_ENDPOINT,
  SARVAM_TTS_MAX_CHARS,
  SarvamTtsProvider,
  readAudioParts,
  segmentText,
} from "./sarvam-provider.js";
import { buildWav, mergeWav, readWav } from "./wav.js";
import { createChainedTtsProvider } from "./provider-chain.js";
import { MockTtsProvider, fakeWavBytes } from "./mock-tts-provider.js";
import { TtsProviderError } from "./provider.js";

/** Unit tests for Sarvam Bulbul, the WAV merge, and the TTS chain. */

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

function audioResponse(...wavs: Buffer[]): Response {
  return jsonResponse(200, { audios: wavs.map((wav) => wav.toString("base64")) });
}

function bodyOf(seen: SeenRequest[], index = 0): Record<string, unknown> {
  return JSON.parse(String(seen[index]?.init.body)) as Record<string, unknown>;
}

describe("SarvamTtsProvider requests", () => {
  it("uses the registry voice/model for the target language", async () => {
    const seen: SeenRequest[] = [];
    const wav = fakeWavBytes("வணக்கம்");
    const provider = new SarvamTtsProvider({
      apiKey: "sarvam-secret",
      fetchImpl: mockFetch(seen, () => audioResponse(wav)),
    });
    const result = await provider.synthesize({ text: "வணக்கம்", language: "ta" });

    assert.equal(result.mimeType, "audio/wav");
    assert.deepEqual([...result.audio], [...wav]);
    assert.equal(seen[0]?.url, SARVAM_TTS_ENDPOINT);
    const headers = seen[0]?.init.headers as Record<string, string>;
    assert.equal(headers["api-subscription-key"], "sarvam-secret");
    assert.deepEqual(bodyOf(seen), {
      text: "வணக்கம்",
      language_code: "ta-IN",
      speaker: "gokul_ta_narration",
      model: SARVAM_DEFAULT_TTS_MODEL,
      speech_sample_rate: 22_050,
      output_audio_codec: "wav",
    });
  });

  it("uses the documented v3 speaker for Malayalam", async () => {
    const seen: SeenRequest[] = [];
    const provider = new SarvamTtsProvider({
      apiKey: "k",
      fetchImpl: mockFetch(seen, () => audioResponse(fakeWavBytes("നമസ്കാരം"))),
    });
    await provider.synthesize({ text: "നമസ്കാരം", language: "ml" });
    assert.equal(bodyOf(seen).speaker, "shubh");
    assert.equal(bodyOf(seen).model, "bulbul:v3");
    assert.equal(bodyOf(seen).language_code, "ml-IN");
  });

  it("applies model/voice overrides when configured", async () => {
    const seen: SeenRequest[] = [];
    const provider = new SarvamTtsProvider({
      apiKey: "k",
      model: "bulbul:v4-flash",
      voice: "custom_voice",
      fetchImpl: mockFetch(seen, () => audioResponse(fakeWavBytes("hi"))),
    });
    await provider.synthesize({ text: "hi", language: "hi" });
    assert.equal(bodyOf(seen).speaker, "custom_voice");
    assert.equal(bodyOf(seen).model, "bulbul:v4-flash");
  });

  it("refuses a language with no published voice without a network call", async () => {
    const seen: SeenRequest[] = [];
    const provider = new SarvamTtsProvider({
      apiKey: "k",
      fetchImpl: mockFetch(seen, () => audioResponse(fakeWavBytes("x"))),
    });
    await assert.rejects(
      provider.synthesize({ text: "Bonjour", language: "fr" }),
      (error: unknown) => {
        assert.ok(error instanceof TtsProviderError);
        assert.equal(error.code, "unsupported");
        return true;
      },
    );
    assert.equal(seen.length, 0);
  });

  it("splits long text, synthesizes each segment, and merges one WAV", async () => {
    const seen: SeenRequest[] = [];
    const sentence = `${"a".repeat(SARVAM_TTS_MAX_CHARS - 1000)}. `;
    const long = `${sentence}${sentence}`;
    const first = fakeWavBytes("a");
    const second = fakeWavBytes("b");
    const provider = new SarvamTtsProvider({
      apiKey: "k",
      // A small ceiling forces two segments from the three short sentences.
      fetchImpl: mockFetch(seen, () =>
        seen.length === 1 ? audioResponse(first) : audioResponse(second),
      ),
    });
    const result = await provider.synthesize({ text: long, language: "en" });

    assert.equal(seen.length, 2);
    assert.equal(readWav(result.audio)?.sampleRate, 24_000);
    assert.deepEqual([...result.audio], [...(mergeWav([first, second]) as Buffer)]);
  });

  it("classifies provider failures", async () => {
    const statuses: ReadonlyArray<[number, string]> = [
      [401, "auth"],
      [429, "rate_limited"],
      [400, "unsupported"],
      [500, "network"],
    ];
    for (const [status, code] of statuses) {
      const provider = new SarvamTtsProvider({
        apiKey: "k",
        fetchImpl: mockFetch([], () => jsonResponse(status, {})),
      });
      await assert.rejects(
        provider.synthesize({ text: "hi", language: "hi" }),
        (error: unknown) => {
          assert.ok(error instanceof TtsProviderError, `status ${status}`);
          assert.equal(error.code, code, `status ${status}`);
          return true;
        },
      );
    }
  });

  it("rejects a response with no audio", async () => {
    const provider = new SarvamTtsProvider({
      apiKey: "k",
      fetchImpl: mockFetch([], () => jsonResponse(200, { audios: [] })),
    });
    await assert.rejects(provider.synthesize({ text: "hi", language: "hi" }), /no audio/);
  });

  it("validates the documented audios array", () => {
    assert.deepEqual(readAudioParts({ audios: ["a", "", "b"] }), ["a", "b"]);
    assert.equal(readAudioParts({}), null);
    assert.equal(readAudioParts(null), null);
  });
});

describe("segmentText", () => {
  it("returns a single short segment untouched", () => {
    assert.deepEqual(segmentText("  hello  ", 100), ["hello"]);
    assert.deepEqual(segmentText("", 100), []);
  });

  it("prefers sentence boundaries within the ceiling", () => {
    const text = "One. Two! Three?";
    assert.deepEqual(segmentText(text, 8), ["One.", "Two!", "Three?"]);
  });

  it("hard-splits a single sentence over the ceiling", () => {
    const segments = segmentText("x".repeat(25), 10);
    assert.equal(segments.length, 3);
    assert.ok(segments.every((segment) => segment.length <= 10));
    assert.equal(segments.join(""), "x".repeat(25));
  });
});

describe("WAV merge", () => {
  it("joins compatible PCM payloads behind one header", () => {
    const a = fakeWavBytes("ab");
    const b = fakeWavBytes("cd");
    const merged = mergeWav([a, b]);
    assert.ok(merged);
    assert.equal(merged.length, a.length + b.length - 44);
    const parts = readWav(merged);
    assert.ok(parts);
    assert.equal(parts.channels, 1);
    assert.equal(parts.sampleRate, 24_000);
    assert.equal(parts.bitsPerSample, 16);
  });

  it("refuses to merge incompatible formats", () => {
    const mono = fakeWavBytes("a");
    const other = buildWav({ channels: 2, sampleRate: 44_100, bitsPerSample: 16, data: Buffer.alloc(4) });
    assert.equal(mergeWav([mono, other]), null);
  });

  it("reads a malformed buffer as null", () => {
    assert.equal(readWav(Buffer.from("not a wav")), null);
    assert.equal(mergeWav([]), null);
  });
});

describe("TTS provider chain", () => {
  it("routes an unlisted language to the accept-all member", () => {
    const sarvam = new MockTtsProvider({ languages: ["ta", "hi"] });
    const gemini = new MockTtsProvider();
    const chain = createChainedTtsProvider([sarvam, gemini]);
    assert.ok(chain);
    assert.equal(chain.select?.("ta"), sarvam);
    assert.equal(chain.select?.("fr"), gemini);
    assert.equal(chain.languages.includes("ta"), true);
    assert.equal(chain.cacheTag, "mock|mock");
  });

  it("returns null when no member accepts the language", () => {
    const chain = createChainedTtsProvider([
      new MockTtsProvider({ languages: ["ta"] }),
      new MockTtsProvider({ languages: ["hi"] }),
    ]);
    assert.ok(chain);
    assert.equal(chain.select?.("fr"), null);
  });

  it("falls back to the next accepting member when the first errors", async () => {
    const sarvam = new MockTtsProvider({
      languages: ["ta"],
      failures: { ta: "network" },
    });
    const gemini = new MockTtsProvider();
    const chain = createChainedTtsProvider([sarvam, gemini]);
    assert.ok(chain);
    const result = await chain.synthesize({ text: "வணக்கம்", language: "ta" });
    assert.equal(sarvam.calls.length, 1);
    assert.equal(gemini.calls.length, 1);
    assert.equal(result.mimeType, "audio/wav");
  });

  it("throws unsupported from a chain when nothing accepts the language", async () => {
    const chain = createChainedTtsProvider([
      new MockTtsProvider({ languages: ["ta"] }),
      new MockTtsProvider({ languages: ["hi"] }),
    ]);
    await assert.rejects(
      chain!.synthesize({ text: "x", language: "fr" }),
      (error: unknown) => {
        assert.ok(error instanceof TtsProviderError);
        assert.equal(error.code, "unsupported");
        return true;
      },
    );
  });

  it("returns a single member untouched and null for no members", () => {
    const only = new MockTtsProvider({ languages: ["ta"] });
    assert.equal(createChainedTtsProvider([only]), only);
    assert.equal(createChainedTtsProvider([]), null);
    assert.equal(createChainedTtsProvider([null]), null);
  });
});
