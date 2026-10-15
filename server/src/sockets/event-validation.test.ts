import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_TEXT_LENGTH } from "../rooms/room-validation.js";
import {
  MAX_UTTERANCE_ID_LENGTH,
  MIN_UTTERANCE_ID_LENGTH,
  isUtteranceId,
  parseInterimPayload,
  parseUtterancePayload,
  sanitizeInterimText,
} from "./event-validation.js";

const VALID_ID = "0f66a2c1-9f4e-4b0e-9c2e-1c5b8a7d3e10";

describe("utterance id validation", () => {
  it("accepts a UUID-style id and opaque tokens", () => {
    assert.equal(isUtteranceId(VALID_ID), true);
    assert.equal(isUtteranceId("abc123DEF_456"), true);
  });

  it("rejects short, long, and malformed ids", () => {
    assert.equal(isUtteranceId("short"), false);
    assert.equal(isUtteranceId("x".repeat(MAX_UTTERANCE_ID_LENGTH + 1)), false);
    assert.equal(isUtteranceId("has spaces in it"), false);
    assert.equal(isUtteranceId("has:colons"), false);
    assert.equal(isUtteranceId(42), false);
    assert.equal(isUtteranceId(undefined), false);
  });

  it("mirrors the client's minimum length", () => {
    assert.equal(isUtteranceId("a".repeat(MIN_UTTERANCE_ID_LENGTH)), true);
    assert.equal(isUtteranceId("a".repeat(MIN_UTTERANCE_ID_LENGTH - 1)), false);
  });
});

describe("conversation:utterance payload", () => {
  it("accepts a well-formed payload and trims the text", () => {
    const parsed = parseUtterancePayload({
      utteranceId: VALID_ID,
      text: "  Vanakkam  ",
      language: "ta",
    });
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok && parsed.value, {
      utteranceId: VALID_ID,
      text: "Vanakkam",
      language: "ta",
    });
  });

  it("rejects a payload without an utterance id", () => {
    const parsed = parseUtterancePayload({ text: "hi", language: "en" });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.ok === false && parsed.error.code, "invalid_payload");
  });

  it("rejects identity fields smuggled beside the text", () => {
    const parsed = parseUtterancePayload({
      utteranceId: VALID_ID,
      text: "hi",
      language: "en",
      side: "a",
    });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.ok === false && parsed.error.code, "invalid_payload");
  });

  it("rejects empty or oversized text", () => {
    const empty = parseUtterancePayload({
      utteranceId: VALID_ID,
      text: "   ",
      language: "en",
    });
    assert.equal(empty.ok, false);
    const huge = parseUtterancePayload({
      utteranceId: VALID_ID,
      text: "x".repeat(MAX_TEXT_LENGTH + 1),
      language: "en",
    });
    assert.equal(huge.ok, false);
  });
});

describe("conversation:interim payload", () => {
  it("accepts partial text", () => {
    const parsed = parseInterimPayload({ text: "hello wor", language: "en" });
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok && parsed.value, {
      text: "hello wor",
      language: "en",
    });
  });

  it("accepts an empty string as the clear-line signal", () => {
    const parsed = parseInterimPayload({ text: "", language: "en" });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok && parsed.value.text, "");
    const whitespace = parseInterimPayload({ text: "   ", language: "en" });
    assert.equal(whitespace.ok, true);
    assert.equal(whitespace.ok && whitespace.value.text, "");
  });

  it("rejects oversized text, bad languages, and unknown keys", () => {
    assert.equal(
      parseInterimPayload({
        text: "x".repeat(MAX_TEXT_LENGTH + 1),
        language: "en",
      }).ok,
      false,
    );
    assert.equal(
      parseInterimPayload({ text: "hi", language: "english" }).ok,
      false,
    );
    assert.equal(
      parseInterimPayload({ text: "hi", language: "en", side: "b" }).ok,
      false,
    );
  });

  it("trims interim text edges", () => {
    assert.equal(sanitizeInterimText("  partial  "), "partial");
    assert.equal(sanitizeInterimText(123), null);
  });
});
