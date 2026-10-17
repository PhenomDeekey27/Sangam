import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePlaybackUnavailablePayload } from "@/features/playback/services/playback-unavailable-payload";

const REASONS = [
  "provider_unavailable",
  "unsupported_language",
  "synthesis_failed",
  "audio_dropped",
] as const;

describe("parsePlaybackUnavailablePayload", () => {
  it("accepts a well-formed frame and normalizes the language code", () => {
    assert.deepEqual(
      parsePlaybackUnavailablePayload({
        utteranceId: "utt-play-01",
        sequence: 3,
        language: "pa",
        reason: "provider_unavailable",
      }),
      {
        utteranceId: "utt-play-01",
        sequence: 3,
        language: "pa",
        reason: "provider_unavailable",
      },
    );
  });

  it("accepts every documented reason", () => {
    for (const reason of REASONS) {
      assert.equal(
        parsePlaybackUnavailablePayload({
          utteranceId: "utt-play-02",
          sequence: 1,
          language: "hi",
          reason,
        })?.reason,
        reason,
      );
    }
  });

  it("rejects a malformed frame instead of speaking the wrong text", () => {
    const bad: unknown[] = [
      null,
      undefined,
      "utterance",
      42,
      [],
      { uttneranceId: "typo", sequence: 1, language: "pa", reason: REASONS[0] },
      { utteranceId: "bad id!", sequence: 1, language: "pa", reason: REASONS[0] },
      { utteranceId: "", sequence: 1, language: "pa", reason: REASONS[0] },
      {
        utteranceId: "a".repeat(65),
        sequence: 1,
        language: "pa",
        reason: REASONS[0],
      },
      { utteranceId: "utt-play-03", sequence: 0, language: "pa", reason: REASONS[0] },
      { utteranceId: "utt-play-03", sequence: -1, language: "pa", reason: REASONS[0] },
      {
        utteranceId: "utt-play-03",
        sequence: Number.NaN,
        language: "pa",
        reason: REASONS[0],
      },
      {
        utteranceId: "utt-play-03",
        sequence: Number.POSITIVE_INFINITY,
        language: "pa",
        reason: REASONS[0],
      },
      { utteranceId: "utt-play-03", sequence: "2", language: "pa", reason: REASONS[0] },
      { utteranceId: "utt-play-03", sequence: 1, language: "klingon", reason: REASONS[0] },
      { utteranceId: "utt-play-03", sequence: 1, language: 7, reason: REASONS[0] },
      { utteranceId: "utt-play-03", sequence: 1, language: "pa", reason: "exploded" },
      { utteranceId: "utt-play-03", sequence: 1, language: "pa" },
    ];
    for (const payload of bad) {
      assert.equal(
        parsePlaybackUnavailablePayload(payload),
        null,
        JSON.stringify(payload),
      );
    }
  });
});
