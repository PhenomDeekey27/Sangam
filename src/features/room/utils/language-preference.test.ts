import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LISTENING_PARAM,
  SPEAKING_PARAM,
  languageQuery,
  partnerPreferences,
  preferencesFromSearch,
  readLanguagePreferences,
  resolveLanguage,
  roomInvitePath,
  type LanguagePreferences,
} from "@/features/room/utils/language-preference";
import {
  DEFAULT_LISTENING_LANGUAGE,
  DEFAULT_SPEAKING_LANGUAGE,
  isSupportedLanguage,
  supportedLanguageOrNull,
} from "@/features/translation/data/languages";

describe("resolveLanguage", () => {
  it("preserves a supported selection instead of replacing it", () => {
    assert.equal(resolveLanguage("ta", DEFAULT_SPEAKING_LANGUAGE), "ta");
    assert.equal(resolveLanguage("hi", DEFAULT_LISTENING_LANGUAGE), "hi");
  });

  it("normalizes case and padding (BCP-47 tags are case-insensitive)", () => {
    assert.equal(resolveLanguage(" TA ", "en"), "ta");
    assert.equal(resolveLanguage("HI", "en"), "hi");
  });

  it("takes the first value when a parameter is repeated", () => {
    assert.equal(resolveLanguage(["bn", "ta"], "en"), "bn");
  });

  it("falls back only when nothing valid was supplied", () => {
    for (const value of [
      undefined,
      null,
      "",
      "   ",
      "english",
      "xx",
      "en-US",
    ]) {
      assert.equal(
        resolveLanguage(value, "ta"),
        "ta",
        `value: ${String(value)}`,
      );
    }
  });
});

describe("readLanguagePreferences", () => {
  it("defaults both halves when the URL carries no preferences", () => {
    assert.deepEqual(readLanguagePreferences({}), {
      speaking: DEFAULT_SPEAKING_LANGUAGE,
      listening: DEFAULT_LISTENING_LANGUAGE,
    });
  });

  it("reads both halves independently", () => {
    assert.deepEqual(
      readLanguagePreferences({
        [SPEAKING_PARAM]: "hi",
        [LISTENING_PARAM]: "en",
      }),
      { speaking: "hi", listening: "en" },
    );
  });

  it("never lets one invalid half disturb the other", () => {
    assert.deepEqual(
      readLanguagePreferences({
        [SPEAKING_PARAM]: "klingon",
        [LISTENING_PARAM]: "ta",
      }),
      { speaking: DEFAULT_SPEAKING_LANGUAGE, listening: "ta" },
    );
    assert.deepEqual(
      readLanguagePreferences({
        [SPEAKING_PARAM]: "hi",
        [LISTENING_PARAM]: "xx",
      }),
      { speaking: "hi", listening: DEFAULT_LISTENING_LANGUAGE },
    );
  });
});

describe("query round trip", () => {
  it("writes only the two language codes", () => {
    const query = languageQuery({ speaking: "hi", listening: "en" });
    assert.equal(query, `${SPEAKING_PARAM}=hi&${LISTENING_PARAM}=en`);
    assert.equal(new URLSearchParams(query).get("code"), null);
    assert.equal(new URLSearchParams(query).size, 2);
  });

  it("parses back to the same preferences", () => {
    const preferences: LanguagePreferences = {
      speaking: "ta",
      listening: "fr",
    };
    assert.deepEqual(
      preferencesFromSearch(languageQuery(preferences)),
      preferences,
    );
  });

  it("swaps the two halves for the partner", () => {
    assert.deepEqual(partnerPreferences({ speaking: "hi", listening: "en" }), {
      speaking: "en",
      listening: "hi",
    });
  });
});

describe("invite links", () => {
  it("carries this participant's preferences mirrored for the partner", () => {
    const mine: LanguagePreferences = { speaking: "hi", listening: "ta" };
    const invite = roomInvitePath("QWE234", mine);

    assert.equal(invite, "/room/QWE234?speak=ta&hear=hi");
    assert.deepEqual(preferencesFromSearch(invite.split("?")[1] ?? ""), {
      speaking: "ta",
      listening: "hi",
    });
  });

  it("keeps a valid selection even when the other half is unsupported", () => {
    const invite = roomInvitePath("QWE235", {
      speaking: "xx",
      listening: "bn",
    });
    assert.deepEqual(preferencesFromSearch(invite.split("?")[1] ?? ""), {
      speaking: "bn",
      listening: DEFAULT_LISTENING_LANGUAGE,
    });
  });

  it("mirrors the two-person example: A speaks Tamil/hears Telugu, so B speaks Telugu/hears Tamil", () => {
    const invite = roomInvitePath("ABT234", {
      speaking: "ta",
      listening: "te",
    });
    assert.deepEqual(preferencesFromSearch(invite.split("?")[1] ?? ""), {
      speaking: "te",
      listening: "ta",
    });
  });

  it("contains no identity or secret beyond the room code and languages", () => {
    const invite = roomInvitePath("QWE236", {
      speaking: "hi",
      listening: "ta",
    });
    const params = new URLSearchParams(invite.split("?")[1] ?? "");
    assert.deepEqual([...params.keys()].sort(), [
      LISTENING_PARAM,
      SPEAKING_PARAM,
    ]);
  });
});

describe("supported language helpers", () => {
  it("accepts the shipped list and refuses everything else", () => {
    assert.equal(isSupportedLanguage("en"), true);
    assert.equal(isSupportedLanguage("TA"), true);
    assert.equal(isSupportedLanguage("en-US"), false);
    assert.equal(isSupportedLanguage(42), false);
    assert.equal(supportedLanguageOrNull(" BN "), "bn");
    assert.equal(supportedLanguageOrNull("nope"), null);
  });
});
