import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SpeechSynthesisFallback,
  type SpeechSynthesisEngine,
} from "@/features/playback/services/speech-synthesis";
import type { PlaybackUnavailablePayload } from "@/types/socket";

/** The subset of a real utterance the fallback touches, with test handles. */
interface SpokenLine {
  text: string;
  lang: string;
  voice: SpeechSynthesisVoice | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

/**
 * Deterministic double for `window.speechSynthesis`: it records what was
 * spoken and lets a test finish the active line, so no real synthesizer (and
 * no real audio) is involved.
 */
class FakeEngine implements SpeechSynthesisEngine {
  readonly supported: boolean;
  readonly spoken: SpokenLine[] = [];
  cancels = 0;
  voicesList: readonly SpeechSynthesisVoice[] = [];

  constructor(supported = true) {
    this.supported = supported;
  }

  speak(utterance: SpeechSynthesisUtterance): void {
    this.spoken.push(utterance as unknown as SpokenLine);
  }

  cancel(): void {
    this.cancels += 1;
  }

  voices(): readonly SpeechSynthesisVoice[] {
    return this.voicesList;
  }

  createUtterance(text: string): SpeechSynthesisUtterance {
    const line: SpokenLine = {
      text,
      lang: "",
      voice: null,
      onend: null,
      onerror: null,
    };
    return line as unknown as SpeechSynthesisUtterance;
  }

  /** Fire the active line's `onend`, as a browser would when it finishes. */
  finish(): void {
    this.spoken[this.spoken.length - 1]?.onend?.();
  }
}

const TEXTS: Record<string, string> = {
  u1: "one",
  u2: "two",
  u3: "three",
};

function getText(utteranceId: string): string | null {
  return TEXTS[utteranceId] ?? null;
}

function frame(
  utteranceId: string,
  sequence: number,
  language = "pa",
): PlaybackUnavailablePayload {
  return { utteranceId, sequence, language, reason: "provider_unavailable" };
}

function textsOf(engine: FakeEngine): string[] {
  return engine.spoken.map((line) => line.text);
}

describe("SpeechSynthesisFallback", () => {
  it("speaks queued lines strictly in sequence order", () => {
    const engine = new FakeEngine();
    const fallback = new SpeechSynthesisFallback({ getText, engine });
    assert.equal(fallback.supported, true);

    assert.equal(fallback.enqueue(frame("u1", 1)), true);
    assert.deepEqual(textsOf(engine), ["one"]);

    // Arrive out of order; the queue sorts by sequence behind the active line.
    assert.equal(fallback.enqueue(frame("u3", 3)), true);
    assert.equal(fallback.enqueue(frame("u2", 2)), true);
    engine.finish();
    assert.deepEqual(textsOf(engine), ["one", "two"]);
    engine.finish();
    assert.deepEqual(textsOf(engine), ["one", "two", "three"]);
    engine.finish();
    assert.equal(fallback.size, 0);
    assert.equal(fallback.playedUpTo, 3);
  });

  it("drops a duplicate id and any sequence at or below the watermark", () => {
    const engine = new FakeEngine();
    const fallback = new SpeechSynthesisFallback({ getText, engine });
    assert.equal(fallback.enqueue(frame("u1", 1)), true);
    assert.equal(fallback.enqueue(frame("u1", 1)), false);
    engine.finish();
    assert.equal(fallback.playedUpTo, 1);
    assert.equal(fallback.enqueue(frame("u1", 1)), false);
    assert.equal(fallback.enqueue(frame("u0", 1)), false);
    assert.equal(fallback.enqueue(frame("u2", 2)), true);
  });

  it("never speaks when the browser has no speech synthesis", () => {
    const engine = new FakeEngine(false);
    const fallback = new SpeechSynthesisFallback({ getText, engine });
    assert.equal(fallback.supported, false);
    assert.equal(fallback.enqueue(frame("u1", 1)), false);
    assert.equal(engine.spoken.length, 0);
  });

  it("cancels the interrupted turn, keeps newer speech, and rejects it late", () => {
    const engine = new FakeEngine();
    const fallback = new SpeechSynthesisFallback({ getText, engine });
    assert.equal(fallback.enqueue(frame("u1", 1)), true);
    assert.equal(fallback.enqueue(frame("u2", 2)), true);
    assert.equal(fallback.enqueue(frame("u3", 3)), true);

    fallback.interrupt(2);
    assert.equal(engine.cancels, 1);
    assert.equal(fallback.playedUpTo, 2);
    // u2 is gone; the already-newer u3 starts immediately.
    assert.deepEqual(textsOf(engine), ["one", "three"]);
    // A tardy frame for the interrupted turn stays dead.
    assert.equal(fallback.enqueue(frame("u2", 2)), false);
    assert.equal(fallback.enqueue(frame("u1", 1)), false);
    assert.equal(fallback.size, 0);
  });

  it("advances the watermark while idle so a late frame stays dead", () => {
    const engine = new FakeEngine();
    const fallback = new SpeechSynthesisFallback({ getText, engine });
    fallback.interrupt(4);
    assert.equal(fallback.playedUpTo, 4);
    assert.equal(fallback.enqueue(frame("u4", 4)), false);
    assert.equal(fallback.enqueue(frame("u5", 5)), true);
  });

  it("ignores a non-finite or non-newer interrupt boundary", () => {
    const engine = new FakeEngine();
    const fallback = new SpeechSynthesisFallback({ getText, engine });
    assert.equal(fallback.enqueue(frame("u3", 3)), true);
    fallback.interrupt(3);
    assert.equal(engine.cancels, 1);
    fallback.interrupt(3);
    fallback.interrupt(Number.NaN);
    fallback.interrupt(Number.POSITIVE_INFINITY);
    assert.equal(engine.cancels, 1);
    assert.equal(fallback.playedUpTo, 3);
  });

  it("forgets the watermark and seen ids on reset", () => {
    const engine = new FakeEngine();
    const fallback = new SpeechSynthesisFallback({ getText, engine });
    assert.equal(fallback.enqueue(frame("u1", 1)), true);
    engine.finish();
    assert.equal(fallback.playedUpTo, 1);
    fallback.reset();
    assert.equal(fallback.playedUpTo, 0);
    assert.equal(fallback.enqueue(frame("u1", 1)), true);
  });

  it("skips a line whose translated text is not available yet", () => {
    const engine = new FakeEngine();
    const fallback = new SpeechSynthesisFallback({
      getText: (id) => (id === "u2" ? TEXTS.u2 : null),
      engine,
    });
    assert.equal(fallback.enqueue(frame("u1", 1)), true);
    assert.equal(engine.spoken.length, 0);
    assert.equal(fallback.playedUpTo, 1);
    assert.equal(fallback.enqueue(frame("u2", 2)), true);
    assert.deepEqual(textsOf(engine), ["two"]);
  });

  it("uses a voice matching the target language when one exists", () => {
    const punjabi = { lang: "pa-IN", name: "Punjabi" } as SpeechSynthesisVoice;
    const english = { lang: "en-US", name: "English" } as SpeechSynthesisVoice;

    const engine = new FakeEngine();
    engine.voicesList = [english, punjabi];
    const fallback = new SpeechSynthesisFallback({ getText, engine });
    assert.equal(fallback.enqueue(frame("u1", 1, "pa")), true);
    assert.equal(engine.spoken[0]?.voice, punjabi);
    assert.equal(engine.spoken[0]?.lang, "pa");
  });

  it("leaves the voice unset when no voice matches the language", () => {
    const engine = new FakeEngine();
    engine.voicesList = [
      { lang: "en-US", name: "English" } as SpeechSynthesisVoice,
    ];
    const fallback = new SpeechSynthesisFallback({ getText, engine });
    assert.equal(fallback.enqueue(frame("u2", 2, "ta")), true);
    assert.equal(engine.spoken[0]?.voice, null);
  });
});
