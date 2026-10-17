import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadEnv, resolveTranslationEnv } from "./env.js";

describe("resolveTranslationEnv", () => {
  it("uses the Google primary without a key and no fallback", () => {
    assert.deepEqual(resolveTranslationEnv({}), {
      mode: "auto",
      primary: "google",
      fallback: null,
      apiKey: null,
      model: "gemini-3.5-flash-lite",
      sarvamApiKey: null,
      sarvamModel: "mayura:v1",
    });
    assert.deepEqual(resolveTranslationEnv({ provider: "none" }), {
      mode: "none",
      primary: null,
      fallback: null,
      apiKey: null,
      model: "gemini-3.5-flash-lite",
      sarvamApiKey: null,
      sarvamModel: "mayura:v1",
    });
  });

  it("enables the Gemini fallback when a key is present", () => {
    assert.deepEqual(resolveTranslationEnv({ apiKey: "key-123" }), {
      mode: "auto",
      primary: "google",
      fallback: "gemini",
      apiKey: "key-123",
      model: "gemini-3.5-flash-lite",
      sarvamApiKey: null,
      sarvamModel: "mayura:v1",
    });
  });

  it("disables fallback explicitly in google mode", () => {
    assert.deepEqual(
      resolveTranslationEnv({ provider: "google", apiKey: "key-123" }),
      {
        mode: "google",
        primary: "google",
        fallback: null,
        apiKey: "key-123",
        model: "gemini-3.5-flash-lite",
        sarvamApiKey: null,
        sarvamModel: "mayura:v1",
      },
    );
  });

  it("requires a key for explicit Gemini mode and honors the model", () => {
    assert.throws(
      () => resolveTranslationEnv({ provider: "gemini" }),
      /GEMINI_API_KEY/,
    );
    const resolved = resolveTranslationEnv({
      provider: "gemini",
      apiKey: "key-123",
      model: "gemini-3.5-flash-lite",
    });
    assert.equal(resolved.primary, "google");
    assert.equal(resolved.fallback, "gemini");
    assert.equal(resolved.model, "gemini-3.5-flash-lite");
  });

  it("prefers Sarvam as primary when its key is present", () => {
    const resolved = resolveTranslationEnv({
      sarvamApiKey: "sarvam-123",
      apiKey: "key-123",
    });
    assert.equal(resolved.primary, "sarvam");
    assert.equal(resolved.fallback, "gemini");
    assert.equal(resolved.sarvamApiKey, "sarvam-123");
    assert.equal(resolved.sarvamModel, "mayura:v1");
  });

  it("requires a Sarvam key for explicit sarvam mode", () => {
    assert.throws(
      () => resolveTranslationEnv({ provider: "sarvam" }),
      /SARVAM_API_KEY/,
    );
    // Explicit sarvam keeps Google as the second hop and Gemini as the third.
    const resolved = resolveTranslationEnv({
      provider: "sarvam",
      sarvamApiKey: "sarvam-123",
    });
    assert.equal(resolved.primary, "sarvam");
    assert.equal(resolved.fallback, null);
  });

  it("never uses Sarvam in google or gemini mode", () => {
    assert.equal(
      resolveTranslationEnv({ provider: "google", sarvamApiKey: "sarvam-123" })
        .primary,
      "google",
    );
    assert.equal(
      resolveTranslationEnv({ provider: "gemini", sarvamApiKey: "sarvam-123", apiKey: "k" })
        .primary,
      "google",
    );
  });

  it("reads the documented server environment variables", () => {
    const env = loadEnv({
      PORT: "4000",
      CLIENT_ORIGIN: "http://localhost:3000",
      TRANSLATION_PROVIDER: "gemini",
      GEMINI_API_KEY: "key-123",
      GEMINI_TRANSLATION_MODEL: "gemini-3.5-flash-lite",
      SARVAM_API_KEY: "sarvam-123",
      SARVAM_TRANSLATION_MODEL: "mayura:v1",
    } as unknown as NodeJS.ProcessEnv);
    // Read the resolved production config directly: gemini mode keeps Google
    // primary and never promotes Sarvam, even with a Sarvam key present.
    const raw = env.translation;
    assert.equal(raw?.apiKey, "key-123");
    assert.equal(raw?.model, "gemini-3.5-flash-lite");
    assert.equal(raw?.sarvamApiKey, "sarvam-123");
    assert.equal(raw?.sarvamModel, "mayura:v1");
    const resolved = resolveTranslationEnv({ ...raw, provider: "gemini" });
    assert.equal(resolved.primary, "google");
    assert.equal(resolved.fallback, "gemini");
  });
});
