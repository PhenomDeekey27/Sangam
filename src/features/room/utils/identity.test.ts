import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  directionSentence,
  languageDirection,
  otherSide,
  participantAriaLabel,
  playbackForSide,
  playbackRoleLabels,
  roleLabel,
} from "@/features/room/utils/identity";

describe("participant identity labels", () => {
  it("names the local seat You and the other seat Other participant", () => {
    assert.equal(roleLabel(true), "You");
    assert.equal(roleLabel(false), "Other participant");
  });

  it("shows the stored language direction, not a guessed one", () => {
    // Participant A speaks Tamil and hears English.
    assert.equal(languageDirection("ta", "en"), "Tamil → English");
    // Participant B speaks English and hears Tamil.
    assert.equal(languageDirection("en", "ta"), "English → Tamil");
  });

  it("states the direction from the local participant's viewpoint", () => {
    assert.equal(
      directionSentence(true, "ta", "en"),
      "You speak Tamil and hear English.",
    );
    assert.equal(
      directionSentence(false, "en", "ta"),
      "They speak English and hear Tamil.",
    );
  });

  it("never labels the source speaker as the one hearing the audio", () => {
    // You are seat "b" and the partner on seat "a" is speaking.
    const labels = playbackRoleLabels("a", "en", "b", "Speaker A");
    // The source card says the audio is playing to the listener (you)…
    assert.equal(labels.source, "Playing to you in English");
    // …and the listener card names the source, not itself.
    assert.equal(labels.listener, "Hearing Speaker A in English");
  });

  it("labels the source from the source side when the partner hears", () => {
    // You are seat "a" and you are the source speaking into the room.
    const labels = playbackRoleLabels("a", "ta", "a", "Partner");
    assert.equal(labels.source, "Playing to Partner in Tamil");
    assert.equal(labels.listener, "Hearing you in Tamil");
  });

  it("builds one aria label carrying role, name, and direction", () => {
    const label = participantAriaLabel({
      isSelf: false,
      name: "Speaker A",
      speaks: "ta",
      hears: "en",
      state: "Speaking",
    });
    assert.equal(
      label,
      "Other participant, Speaker A, speaks Tamil, hears English, Speaking",
    );
  });

  it("knows the other seat in a two-person room", () => {
    assert.equal(otherSide("a"), "b");
    assert.equal(otherSide("b"), "a");
  });
});

describe("active playback attribution", () => {
  it("labels the source card and the listener card differently", () => {
    // You are seat "b"; the partner on "a" is being played to you in English.
    const active = { speakerSide: "a" as const, language: "en" as const };
    const source = playbackForSide("a", active, "b", "Speaker A");
    const listener = playbackForSide("b", active, "b", "Speaker A");
    assert.deepEqual(source, {
      role: "source",
      label: "Playing to you in English",
    });
    assert.deepEqual(listener, {
      role: "listener",
      label: "Hearing Speaker A in English",
    });
  });

  it("gives no label when nothing is playing", () => {
    assert.equal(playbackForSide("a", null, "a", "Partner"), null);
  });

  it("marks the source card even when you are the source", () => {
    // You are seat "a" and your speech is being played to the partner.
    const active = { speakerSide: "a" as const, language: "ta" as const };
    assert.deepEqual(playbackForSide("a", active, "a", "Partner"), {
      role: "source",
      label: "Playing to Partner in Tamil",
    });
    assert.deepEqual(playbackForSide("b", active, "a", "Partner"), {
      role: "listener",
      label: "Hearing you in Tamil",
    });
  });
});
