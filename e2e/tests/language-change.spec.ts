/**
 * Scenario 10: a language change while an utterance is still in flight.
 *
 * The listener closes mid-turn and rejoins with a different "hear" language.
 * A new browser context is used (rather than re-joining the same socket) to
 * avoid the room-full race while the old seat is still closing. The suite then
 * proves the *next* utterance is translated and spoken in the new language,
 * while the interrupted turn's audio is never replayed.
 */
import { expect, test } from "@playwright/test";
import { controlClient, openParticipant, roomCode } from "../helpers/room";
import { playbackView, received } from "../helpers/payloads";

test.describe("language change", () => {
  test("an in-flight turn is dropped and later turns use the new language", async ({
    browser,
  }) => {
    const control = controlClient();
    await control.reset();
    const code = roomCode("language-change");
    const a = await openParticipant(browser);
    const b1 = await openParticipant(browser);
    try {
      await a.enter({ code, speak: "en", hear: "ta", create: true });
      await b1.enter({ code, speak: "ta", hear: "en" });
      await a.waitForPartner();
      await b1.enablePlayback();

      // An utterance is translated and its synthesis is held in flight while
      // the listener leaves.
      await control.configureTts({ mode: "deferred" });
      await a.send("before the change");
      await control.waitForTtsPending(1);

      await b1.close();
      await expect(a.interruptButton).toBeDisabled({ timeout: 15_000 });

      // The held synthesis resolves for a listener that is already gone, so it
      // is dropped and nothing plays.
      expect(await control.release()).toBe(1);

      // The same seat rejoins from a fresh context with a new choice of "hear".
      const b2 = await openParticipant(browser);
      try {
        await b2.enter({ code, speak: "ta", hear: "hi" });
        await a.waitForPartner();
        await b2.enablePlayback();

        await control.configureTts({ mode: "immediate", durationMs: 2000 });
        await a.send("after the change");

        const playback = await b2.diag.socket.waitFor(
          (frame) =>
            frame.direction === "in" &&
            frame.event === "conversation:playback" &&
            playbackView(frame.data).sequence === 2,
          { label: "the rejoining listener receives the new turn" },
        );
        expect(playbackView(playback.data).language).toBe("hi");
        await b2.diag.sangam.waitFor(
          (record) =>
            record.kind === "playback" &&
            record.stage === "start" &&
            record.sequence === 2,
          { label: "the new turn plays on the rejoining listener" },
        );

        // The new delivery used the new listening language end to end.
        const state = await control.state();
        const translations = state.translator.calls;
        expect(translations[translations.length - 1].targetLanguage).toBe("hi");
        const ttsCalls = state.tts.calls;
        expect(ttsCalls[ttsCalls.length - 1].language).toBe("hi");

        // The in-flight turn's audio is never replayed to the new listener.
        expect(
          received(b2.diag, "conversation:playback").filter(
            (frame) => playbackView(frame.data).sequence === 1,
          ),
        ).toHaveLength(0);
        expect(received(a.diag, "conversation:playback")).toHaveLength(0);

        a.diag.expectClean();
        b2.diag.expectClean();
      } finally {
        await b2.close();
      }
    } finally {
      await a.close();
    }
  });
});
