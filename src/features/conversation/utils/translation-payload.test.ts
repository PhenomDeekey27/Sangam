import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTranslationUpdate } from "@/features/conversation/utils/translation-payload";

describe("parseTranslationUpdate", () => {
  it("accepts a complete translation for a known utterance", () => {
    assert.deepEqual(
      parseTranslationUpdate({
        utteranceId: "utt-flow-fr-01",
        translation: {
          status: "complete",
          text: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ",
          targetLanguage: "pa",
        },
      }),
      {
        utteranceId: "utt-flow-fr-01",
        translation: {
          status: "complete",
          text: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ",
          targetLanguage: "pa",
        },
      },
    );
  });

  it("accepts a failed translation and normalizes unknown codes", () => {
    assert.deepEqual(
      parseTranslationUpdate({
        utteranceId: "utt-flow-fr-02",
        translation: {
          status: "failed",
          error: { code: "provider_error", message: "Down for now." },
        },
      }),
      {
        utteranceId: "utt-flow-fr-02",
        translation: {
          status: "failed",
          error: { code: "provider_error", message: "Down for now." },
        },
      },
    );
    assert.deepEqual(
      parseTranslationUpdate({
        utteranceId: "utt-flow-fr-02",
        translation: {
          status: "failed",
          error: { code: "timeout", message: "Timed out." },
        },
      }),
      {
        utteranceId: "utt-flow-fr-02",
        translation: {
          status: "failed",
          error: { code: "timeout", message: "Timed out." },
        },
      },
    );
    assert.deepEqual(
      parseTranslationUpdate({
        utteranceId: "utt-flow-fr-02",
        translation: {
          status: "failed",
          error: { code: "exploded", message: "Down for now." },
        },
      })?.translation,
      {
        status: "failed",
        error: { code: "unknown", message: "Down for now." },
      },
    );
  });

  it("rejects malformed updates instead of corrupting the transcript", () => {
    const bad: unknown[] = [
      null,
      "translation",
      {
        utteranceId: "bad id!",
        translation: { status: "complete", text: "x", targetLanguage: "pa" },
      },
      {
        utteranceId: "utt-flow-fr-01",
        translation: { status: "complete", text: "   ", targetLanguage: "pa" },
      },
      {
        utteranceId: "utt-flow-fr-01",
        translation: {
          status: "complete",
          text: "x",
          targetLanguage: "klingon",
        },
      },
      {
        utteranceId: "utt-flow-fr-01",
        translation: { status: "failed", error: { code: "network" } },
      },
      {
        utteranceId: "utt-flow-fr-01",
        translation: { status: "queued" },
      },
      {
        utteranceId: "utt-flow-fr-01",
        translation: { status: "translating" },
      },
      { utteranceId: "utt-flow-fr-01" },
    ];
    for (const payload of bad) {
      assert.equal(
        parseTranslationUpdate(payload),
        null,
        JSON.stringify(payload),
      );
    }
  });
});
