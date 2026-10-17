/**
 * End-to-end interruption suite (scenarios 1-8).
 *
 * Two independent browser contexts each load the real Sangam room; the backend
 * is the real server running the deterministic mock speech provider with
 * scripted translation and a controllable TTS provider, so the production
 * capture → transcript → translate → synthesize → playback pipeline and its
 * interruption safeguards all run unchanged.
 */
import { expect, test } from "@playwright/test";
import { controlClient, openParticipant, roomCode } from "../helpers/room";
import {
  interruptView,
  playbackView,
  received,
  translationTargetOf,
  utteranceIdOf,
  utteranceLanguageOf,
  utteranceSequenceOf,
  utteranceSideOf,
  utteranceTextOf,
} from "../helpers/payloads";

test.describe("interruption", () => {
  test("a spoken turn is transcribed, translated for the listener, and played only to them", async ({
    browser,
  }) => {
    // scenarios 1-3: independent contexts, synthetic mic speech, correlation.
    const control = controlClient();
    await control.reset();
    await control.configureTts({ mode: "immediate", durationMs: 3000 });
    const code = roomCode("mic-correlation");
    const a = await openParticipant(browser);
    const b = await openParticipant(browser);
    try {
      await a.enter({ code, speak: "en", hear: "ta", create: true });
      await b.enter({ code, speak: "ta", hear: "en" });
      await a.waitForPartner();
      await b.enablePlayback();

      // scenario 2: Chromium renders the WAV fixture as a fake microphone, so
      // the real getUserMedia → MediaRecorder → socket capture path runs.
      await a.page
        .getByRole("button", { name: "Turn on the microphone" })
        .click();

      const utterance = await b.diag.socket.waitFor(
        (frame) =>
          frame.direction === "in" && frame.event === "conversation:utterance",
        { label: "the listener receives a finalized utterance" },
      );
      const id = utteranceIdOf(utterance.data);
      expect(utteranceTextOf(utterance.data)).toContain("[mock] recognized");
      expect(utteranceLanguageOf(utterance.data)).toBe("en");
      expect(utteranceSideOf(utterance.data)).toBe("a");
      expect(utteranceSequenceOf(utterance.data)).toBe(1);

      // scenario 3: the same utterance id carries the translation to the
      // listener's chosen language, then its synthesized audio.
      const translation = await b.diag.socket.waitFor(
        (frame) =>
          frame.direction === "in" &&
          frame.event === "conversation:translation" &&
          typeof frame.data === "object" &&
          frame.data !== null &&
          (frame.data as { utteranceId?: string }).utteranceId === id,
        { label: "the listener receives the translation for the same id" },
      );
      expect(translationTargetOf(translation.data)).toBe("ta");

      const playback = await b.diag.socket.waitFor(
        (frame) =>
          frame.direction === "in" &&
          frame.event === "conversation:playback" &&
          playbackView(frame.data).utteranceId === id,
        { label: "the listener receives the audio for the same id" },
      );
      expect(playbackView(playback.data).language).toBe("ta");
      expect(playbackView(playback.data).sequence).toBe(1);

      await b.diag.sangam.waitFor(
        (record) =>
          record.kind === "playback" &&
          record.stage === "start" &&
          record.utteranceId === id &&
          record.sequence === 1,
        { label: "the listener begins playing the utterance" },
      );

      // scenario 1: the speaker's own context never receives translated audio.
      expect(received(a.diag, "conversation:playback")).toHaveLength(0);

      a.diag.expectClean();
      b.diag.expectClean();
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("interrupting a long response stops the audio, advances the boundary, and discards the stale turn", async ({
    browser,
  }) => {
    // scenarios 4-7: long response, real interruption, stale discard, recovery.
    const control = controlClient();
    await control.reset();
    const code = roomCode("interrupt-boundary");
    const a = await openParticipant(browser);
    const b = await openParticipant(browser);
    try {
      await a.enter({ code, speak: "en", hear: "ta", create: true });
      await b.enter({ code, speak: "ta", hear: "en" });
      await a.waitForPartner();
      await b.enablePlayback();

      // scenario 4: an 8s response so the interruption lands mid-playback.
      await control.configureTts({ mode: "immediate", durationMs: 8000 });
      await a.send("first long turn");
      const firstStart = await b.diag.sangam.waitFor(
        (record) =>
          record.kind === "playback" &&
          record.stage === "start" &&
          record.sequence === 1,
        { label: "the long turn starts playing on the listener" },
      );
      const firstId = firstStart.utteranceId ?? "";

      // Hold the next turn's synthesis in flight so the interruption meets a
      // turn that has been translated but not yet delivered.
      await control.configureTts({ mode: "deferred" });
      await a.send("second turn held in flight");
      const secondFrame = await b.diag.socket.waitFor(
        (frame) =>
          frame.direction === "in" &&
          frame.event === "conversation:utterance" &&
          utteranceSequenceOf(frame.data) === 2,
        { label: "the second utterance is relayed" },
      );
      const secondId = utteranceIdOf(secondFrame.data);
      await control.waitForTtsPending(1);

      // scenario 5: trigger the interruption through the real user control.
      await a.interrupt();
      await expect(a.interruptControl).toHaveText(/Interrupted/, {
        timeout: 8000,
      });

      const relayed = await b.diag.socket.waitFor(
        (frame) =>
          frame.direction === "in" &&
          frame.event === "conversation:interrupt" &&
          interruptView(frame.data).sequence === 2,
        { label: "the listener is told to stop up to sequence 2" },
      );
      expect(interruptView(relayed.data).side).toBe("a");

      // scenario 6: the interrupted audio stopped, and the queue advanced.
      await b.diag.sangam.waitFor(
        (record) =>
          record.kind === "playback" &&
          record.stage === "outcome" &&
          record.utteranceId === firstId &&
          record.status === "stopped" &&
          record.reason === "interrupt",
        { label: "the interrupted turn reports a stop" },
      );

      // Releasing the held synthesis proves the stale delivery is discarded.
      expect(await control.release()).toBe(1);
      await b.diag.sangam.waitFor(
        (record) =>
          record.kind === "playback" &&
          record.stage === "queue_discard" &&
          record.sequence === 2,
        { label: "the released stale audio is discarded" },
      );
      expect(
        b.diag.sangam.items.filter(
          (record) =>
            record.stage === "start" && record.utteranceId === secondId,
        ),
      ).toHaveLength(0);

      // scenario 7: the room recovers — the next utterance plays normally.
      await control.configureTts({ mode: "immediate", durationMs: 3000 });
      await a.send("third turn after recovery");
      await b.diag.sangam.waitFor(
        (record) =>
          record.kind === "playback" &&
          record.stage === "start" &&
          record.sequence === 3,
        { label: "the turn after the interruption plays" },
      );
      await b.diag.sangam.waitFor(
        (record) =>
          record.kind === "playback" &&
          record.stage === "state" &&
          record.status === "idle",
        { label: "the listener queue drains after recovery" },
      );
      expect(received(a.diag, "conversation:playback")).toHaveLength(0);

      a.diag.expectClean();
      b.diag.expectClean();
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("repeated interruptions leave no duplicates, stuck queue, or cross-participant audio", async ({
    browser,
  }) => {
    // scenario 8: three back-to-back interruptions, then a clean recovery.
    const control = controlClient();
    await control.reset();
    const code = roomCode("repeat-interrupts");
    const a = await openParticipant(browser);
    const b = await openParticipant(browser);
    try {
      await a.enter({ code, speak: "en", hear: "ta", create: true });
      await b.enter({ code, speak: "ta", hear: "en" });
      await a.waitForPartner();
      await b.enablePlayback();
      await control.configureTts({ mode: "immediate", durationMs: 8000 });

      const startedIds: string[] = [];
      for (let turn = 1; turn <= 3; turn += 1) {
        await a.send(`interruptible turn ${turn}`);
        const start = await b.diag.sangam.waitFor(
          (record) =>
            record.kind === "playback" &&
            record.stage === "start" &&
            record.sequence === turn,
          { label: `turn ${turn} starts playing` },
        );
        startedIds.push(start.utteranceId ?? "");

        await a.interrupt();
        await expect(a.interruptControl).toHaveText(/Interrupted/, {
          timeout: 8000,
        });
        await b.diag.sangam.waitFor(
          (record) =>
            record.kind === "playback" &&
            record.stage === "outcome" &&
            record.utteranceId === start.utteranceId &&
            record.reason === "interrupt",
          { label: `turn ${turn} is stopped by the interruption` },
        );
        // The requester re-arms only after the confirmation reset (1800ms),
        // which also outlasts the 800ms server cooldown.
        await expect(a.interruptButton).toBeEnabled({ timeout: 8000 });
      }

      // No turn played twice, and none leaked to the speaker's context.
      expect(new Set(startedIds).size).toBe(3);
      expect(
        b.diag.sangam.items
          .filter((record) => record.stage === "start")
          .map((record) => record.utteranceId),
      ).toEqual(startedIds);
      expect(received(a.diag, "conversation:playback")).toHaveLength(0);

      // A later turn still plays: the queue is not stuck.
      await control.configureTts({ mode: "immediate", durationMs: 2000 });
      await a.send("turn after repeats");
      await b.diag.sangam.waitFor(
        (record) =>
          record.kind === "playback" &&
          record.stage === "start" &&
          record.sequence === 4,
        { label: "a later turn still plays cleanly" },
      );
      await b.diag.sangam.waitFor(
        (record) =>
          record.kind === "playback" &&
          record.stage === "state" &&
          record.status === "idle",
        { label: "the listener queue drains" },
      );

      a.diag.expectClean();
      b.diag.expectClean();
    } finally {
      await a.close();
      await b.close();
    }
  });
});
