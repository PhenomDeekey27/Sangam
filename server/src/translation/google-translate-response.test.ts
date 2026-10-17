import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseGoogleTranslationResponse } from "./google-translate-response.js";

/**
 * Shape tests for the Google response normalizer. Fixtures marked LIVE are
 * redacted captures from the real endpoints, taken with the fixed sentence
 * "Hello, how are you?" (en -> ta) — never a user transcript. Everything
 * else is a structural variant of a verified shape.
 */

/** LIVE capture: endpoint B single sentence (model-file hash elided). */
const SEGMENTS_SINGLE: unknown = [
  [
    [
      "வணக்கம், நலமா?",
      "Hello, how are you?",
      null,
      null,
      3,
      null,
      null,
      [[]],
      [["ee29150929b269c38979323546d85c49", "tea_DravidianA_en2knmlsitate_2021q3.md"]],
    ],
  ],
  null,
  "en",
  null,
  null,
  null,
  null,
  [],
];

/** LIVE capture: endpoint B, three sentences in original order. */
const SEGMENTS_MULTI: unknown = [
  [
    ["காலை வணக்கம். ", "Good morning. ", null, null, 3],
    ["உங்கள் நாள் எப்படி இருக்கிறீர்கள்? ", "How was your day? ", null, null, 3],
    ["நாளை சந்திப்போம்.", "See you tomorrow.", null, null, 3],
  ],
  null,
  "en",
  null,
  null,
  null,
  null,
  [],
];

/** LIVE capture: endpoint A (`dict-chrome-ex`), plain string array. */
const LIST_SINGLE: unknown = ["வணக்கம், நலமா?"];

/** LIVE capture: endpoint A, ta -> en. */
const LIST_TA_EN: unknown = ["Hi bro, how are you?"];

function ok(parse: ReturnType<typeof parseGoogleTranslationResponse>) {
  assert.equal(parse.ok, true, JSON.stringify(parse));
  if (!parse.ok) throw new Error("unreachable");
  return parse.segments;
}

describe("parseGoogleTranslationResponse — verified shapes", () => {
  it("parses the LIVE single-segment nested capture (endpoint B)", () => {
    const segments = ok(parseGoogleTranslationResponse(SEGMENTS_SINGLE));
    assert.deepEqual(segments.parts, ["வணக்கம், நலமா?"]);
    assert.equal(segments.format, "segment_list");
    assert.equal(segments.detectedSource, "en");
  });

  it("parses the LIVE three-segment capture in original order (endpoint B)", () => {
    const segments = ok(parseGoogleTranslationResponse(SEGMENTS_MULTI));
    assert.equal(segments.format, "segment_list");
    assert.equal(segments.detectedSource, "en");
    assert.equal(segments.parts.length, 3);
    // Joined upstream: segments carry their own trailing spaces, so the
    // join collapses rather than duplicates them.
    assert.equal(
      segments.parts.join(" ").replace(/\s+/g, " ").trim(),
      "காலை வணக்கம். உங்கள் நாள் எப்படி இருக்கிறீர்கள்? நாளை சந்திப்போம்.",
    );
  });

  it("parses the LIVE plain-array capture (endpoint A, en -> ta)", () => {
    const segments = ok(parseGoogleTranslationResponse(LIST_SINGLE));
    assert.deepEqual(segments.parts, ["வணக்கம், நலமா?"]);
    assert.equal(segments.format, "sentence_list");
    assert.equal(segments.detectedSource, null);
  });

  it("parses the LIVE plain-array capture (endpoint A, ta -> en)", () => {
    const segments = ok(parseGoogleTranslationResponse(LIST_TA_EN));
    assert.deepEqual(segments.parts, ["Hi bro, how are you?"]);
    assert.equal(segments.format, "sentence_list");
  });

  it("parses the legacy sentences-object shape", () => {
    const segments = ok(
      parseGoogleTranslationResponse({
        sentences: [{ trans: "Hello", orig: "வணக்கம்", backend: 10 }],
        src: "ta",
      }),
    );
    assert.deepEqual(segments.parts, ["Hello"]);
    assert.equal(segments.format, "sentence_object");
    assert.equal(segments.detectedSource, "ta");
  });

  it("collects multiple string segments in order (endpoint A variant)", () => {
    const segments = ok(
      parseGoogleTranslationResponse(["Hello ", "brother", " welcome"]),
    );
    assert.deepEqual(segments.parts, ["Hello ", "brother", " welcome"]);
  });
});

describe("parseGoogleTranslationResponse — rejections", () => {
  it("rejects empty and blank-only shapes", () => {
    for (const body of [[], ["   "], { sentences: [], src: "ta" }]) {
      const parse = parseGoogleTranslationResponse(body);
      assert.equal(parse.ok, false, JSON.stringify(body));
      if (parse.ok) throw new Error("unreachable");
      assert.equal(parse.rejection, "empty");
    }
  });

  it("rejects mixed dictionary-style arrays as unexpected", () => {
    const parse = parseGoogleTranslationResponse(["வணக்கம்", ["hello", "NOUN"]]);
    assert.equal(parse.ok, false);
    if (parse.ok) throw new Error("unreachable");
    assert.equal(parse.rejection, "unexpected");
    assert.equal(parse.format, "sentence_list");
  });

  it("rejects segment rows that do not carry a translation", () => {
    for (const body of [
      [[["x"], "not-a-row"]],
      [[[null, "Hello, how are you?"]]],
      [[[42, "Hello, how are you?"]]],
    ]) {
      const parse = parseGoogleTranslationResponse(body);
      assert.equal(parse.ok, false, JSON.stringify(body));
      if (parse.ok) throw new Error("unreachable");
      assert.equal(parse.rejection, "unexpected");
    }
  });

  it("rejects sentences-object entries without string trans", () => {
    for (const body of [
      { sentences: [42], src: "ta" },
      { sentences: [{ nope: true }], src: "ta" },
      { sentences: [{ trans: 7 }], src: "ta" },
    ]) {
      const parse = parseGoogleTranslationResponse(body);
      assert.equal(parse.ok, false, JSON.stringify(body));
      if (parse.ok) throw new Error("unreachable");
      assert.equal(parse.rejection, "unexpected");
    }
  });

  it("rejects primitives and unrecognizable objects", () => {
    for (const body of ["not-an-object", 42, null, true, { src: "ta" }]) {
      const parse = parseGoogleTranslationResponse(body);
      assert.equal(parse.ok, false, JSON.stringify(body));
      if (parse.ok) throw new Error("unreachable");
      assert.equal(parse.rejection, "unexpected");
    }
  });

  it("rejects absurdly long segment counts", () => {
    const rows = Array.from({ length: 129 }, (_, i) => [String(i), "orig"]);
    const parse = parseGoogleTranslationResponse([rows]);
    assert.equal(parse.ok, false);
    if (parse.ok) throw new Error("unreachable");
    assert.equal(parse.rejection, "unexpected");
  });
});
