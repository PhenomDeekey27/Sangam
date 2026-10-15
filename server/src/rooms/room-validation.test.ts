import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_TEXT_LENGTH,
  isLanguageCode,
  isRoomCode,
  normalizeRoomCode,
  sanitizeDisplayName,
  sanitizeText,
} from "./room-validation.js";

describe("room-code validation (mirrors the frontend utility)", () => {
  it("accepts a generated-format code", () => {
    assert.equal(isRoomCode("ABC234"), true);
  });

  it("normalizes case and whitespace", () => {
    assert.equal(normalizeRoomCode("  abc234 "), "ABC234");
    assert.equal(isRoomCode(" abc234 "), true);
  });

  it("rejects wrong length", () => {
    assert.equal(isRoomCode("ABC23"), false);
    assert.equal(isRoomCode("ABC2345"), false);
    assert.equal(isRoomCode(""), false);
  });

  it("rejects ambiguous characters removed from the alphabet", () => {
    assert.equal(isRoomCode("ABCD0O"), false); // 0 and O excluded
    assert.equal(isRoomCode("ABC1IL"), false); // 1, I, L excluded
  });

  it("rejects non-strings", () => {
    assert.equal(isRoomCode(42), false);
    assert.equal(isRoomCode(null), false);
    assert.equal(isRoomCode(undefined), false);
  });
});

describe("language validation", () => {
  it("accepts simple and region-tagged codes", () => {
    assert.equal(isLanguageCode("en"), true);
    assert.equal(isLanguageCode("zh"), true);
    assert.equal(isLanguageCode("pt-BR"), true);
    assert.equal(isLanguageCode("es-419"), true);
  });

  it("rejects junk", () => {
    assert.equal(isLanguageCode("english"), false);
    assert.equal(isLanguageCode("E"), false);
    assert.equal(isLanguageCode(""), false);
    assert.equal(isLanguageCode(123), false);
  });
});

describe("text sanitization", () => {
  it("trims and returns usable text", () => {
    assert.equal(sanitizeText("  hello  "), "hello");
  });

  it("rejects empty, oversized, and non-string text", () => {
    assert.equal(sanitizeText("   "), null);
    assert.equal(sanitizeText("x".repeat(MAX_TEXT_LENGTH + 1)), null);
    assert.equal(sanitizeText(7), null);
    assert.equal(sanitizeText(null), null);
  });

  it("accepts text at exactly the limit", () => {
    assert.equal(
      sanitizeText("x".repeat(MAX_TEXT_LENGTH))?.length,
      MAX_TEXT_LENGTH,
    );
  });
});

describe("display-name sanitization", () => {
  it("defaults when absent", () => {
    assert.deepEqual(sanitizeDisplayName(undefined), { ok: true, name: null });
    assert.deepEqual(sanitizeDisplayName(null), { ok: true, name: null });
  });

  it("keeps a trimmed in-range name", () => {
    assert.deepEqual(sanitizeDisplayName("  Ravi  "), {
      ok: true,
      name: "Ravi",
    });
  });

  it("rejects non-strings; defaults empty or oversized names", () => {
    assert.deepEqual(sanitizeDisplayName(9), { ok: false });
    assert.deepEqual(sanitizeDisplayName("   "), { ok: true, name: null });
    assert.deepEqual(sanitizeDisplayName("x".repeat(25)), {
      ok: true,
      name: null,
    });
  });
});
