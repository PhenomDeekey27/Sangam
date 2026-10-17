/**
 * Scenario 9: delayed synthesis, provider failure, and the browser
 * `speechSynthesis` fallback.
 *
 * The controllable TTS provider can be switched between a held ("deferred")
 * synthesis and one that fails after being released ("fail-deferred"). That
 * lets the suite prove both that a slow server voice still arrives, and that a
 * provider outage hands the translated line to the client's own synthesizer —
 * which is observed through a deterministic recorder, never a real voice.
 */
import { expect, test } from "@playwright/test";
import { controlClient, openParticipant, roomCode } from "../helpers/room";
import { readSpeechSpy } from "../helpers/speech-spy";
import {
  playbackView,
  received,
  unavailableView,
  utteranceIdOf,
  utteranceSequenceOf,
} from "../helpers/payloads";

test.describe("playback fallback", () => {
  test("a delayed synthesis still reaches the listener after the wait", async ({
    browser,
  }) => {
    const control = controlClient();
    await control.reset();
    const code = roomCode("delayed-tts");
    const a = await openParticipant(browser);
    const b = await openParticipant(browser);
    try {
      await a.enter({ code, speak: "en", hear: "ta", create: true });
      await b.enter({ code, speak: "ta", hear: "en" });
      await a.waitForPartner();
      await b.enablePlayback();

      await control.configureTts({ mode: "deferred", durationMs: 2000 });
      await a.send("delayed phrase");
      await control.waitForTtsPending(1);
      expect((await control.state()).tts.mode).toBe("deferred");

      expect(await control.release()).toBe(1);

      const playback = await b.diag.socket.waitFor(
        (frame) =>
          frame.direction === "in" &&
          frame.event === "conversation:playback" &&
          playbackView(frame.data).sequence === 1,
        { label: "the delayed audio arrives after release" },
      );
      expect(playbackView(playback.data).language).toBe("ta");
      await b.diag.sangam.waitFor(
        (record) =>
          record.kind === "playback" &&
          record.stage === "start" &&
          record.sequence === 1,
        { label: "the delayed audio starts playing" },
      );

      a.diag.expectClean();
      b.diag.expectClean();
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("a synthesis failure falls back to the browser speech synthesizer", async ({
    browser,
  }) => {
    const control = controlClient();
    await control.reset();
    const code = roomCode("fallback-speech");
    const a = await openParticipant(browser);
    const b = await openParticipant(browser, { speechSpy: true });
    try {
      await a.enter({ code, speak: "en", hear: "ta", create: true });
      await b.enter({ code, speak: "ta", hear: "en" });
      await a.waitForPartner();
      await b.enablePlayback();

      // Fail only after the translated row has rendered, so the client reads
      // real text when the "unavailable" frame asks it to speak.
      await control.configureTts({ mode: "fail-deferred" });
      await a.send("fallback phrase");

      const utterance = await b.diag.socket.waitFor(
        (frame) =>
          frame.direction === "in" &&
          frame.event === "conversation:utterance" &&
          utteranceSequenceOf(frame.data) === 1,
        { label: "the listener receives the utterance" },
      );
      const id = utteranceIdOf(utterance.data);
      const translatedText = "fallback phrase [en->ta]";
      await expect(b.page.getByText(translatedText)).toBeVisible({
        timeout: 20_000,
      });

      await control.release();
      const unavailable = await b.diag.socket.waitFor(
        (frame) =>
          frame.direction === "in" &&
          frame.event === "conversation:playback_unavailable" &&
          unavailableView(frame.data).utteranceId === id &&
          unavailableView(frame.data).reason === "synthesis_failed",
        { label: "the listener is told no server audio is coming" },
      );
      expect(unavailableView(unavailable.data).language).toBe("ta");

      await expect
        .poll(async () => (await readSpeechSpy(b.page)).spoken.length, {
          timeout: 15_000,
        })
        .toBeGreaterThan(0);
      const spoken = (await readSpeechSpy(b.page)).spoken;
      expect(spoken[0].text).toContain(translatedText);
      expect(spoken[0].lang).toBe("ta");

      // No server audio was delivered for the failed turn.
      expect(received(b.diag, "conversation:playback")).toHaveLength(0);
      expect(
        b.diag.sangam.items.filter((record) => record.stage === "start"),
      ).toHaveLength(0);

      a.diag.expectClean();
      b.diag.expectClean();
    } finally {
      await a.close();
      await b.close();
    }
  });
});
