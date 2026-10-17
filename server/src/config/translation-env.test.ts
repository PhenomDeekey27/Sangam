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
    });
    assert.deepEqual(resolveTranslationEnv({ provider: "none" }), {
      mode: "none",
      primary: null,
      fallback: null,
      apiKey: null,
      model: "gemini-3.5-flash-lite",
    });
  });

  it("enables the Gemini fallback when a key is present", () => {
    assert.deepEqual(resolveTranslationEnv({ apiKey: "key-123" }), {
      mode: "auto",
      primary: "google",
      fallback: "gemini",
      apiKey: "key-123",
      model: "gemini-3.5-flash-lite",
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

  it("reads the documented server environment variables", () => {
    const env = loadEnv({
      PORT: "4000",
      CLIENT_ORIGIN: "http://localhost:3000",
      TRANSLATION_PROVIDER: "gemini",
      GEMINI_API_KEY: "key-123",
      GEMINI_TRANSLATION_MODEL: "gemini-3.5-flash-lite",
    } as unknown as NodeJS.ProcessEnv);
    const resolved = resolveTranslationEnv(env.translation);
    assert.equal(resolved.primary, "google");
    assert.equal(resolved.fallback, "gemini");
    assert.equal(resolved.apiKey, "key-123");
    assert.equal(resolved.model, "gemini-3.5-flash-lite");
  });
});
