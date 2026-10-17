/**
 * Browser `speechSynthesis` spy for the fallback scenarios.
 *
 * Headless Chromium exposes `speechSynthesis` but never actually speaks, and
 * real `speak()` calls may never fire `onend`, which would leave the client's
 * fallback queue parked on its first line. This init script replaces the
 * synthesizer with a deterministic recorder that also ends each utterance, so
 * the app's own `SpeechSynthesisFallback` ordering loop runs for real while the
 * test observes exactly what would have been spoken (text and language).
 *
 * It is installed with `context.addInitScript`, so it is in place before any
 * application code runs.
 */
import type { Page } from "@playwright/test";

export interface SpokenLine {
  readonly text: string;
  readonly lang: string;
}

export interface SpeechSpyState {
  readonly spoken: SpokenLine[];
  readonly cancels: number;
}

export function speechSpyInitScript(): void {
  interface UtteranceLike {
    text: string;
    lang: string;
    voice: unknown;
    onstart: (() => void) | null;
    onend: (() => void) | null;
    onerror: (() => void) | null;
  }
  interface Spy {
    spoken: SpokenLine[];
    cancels: number;
  }
  // `globalThis` (not `window`) so this file needs no DOM lib and can still be
  // typechecked alongside the Node-only Playwright helpers.
  const globalRef = globalThis as unknown as { __e2eSpeech?: Spy };
  const state: Spy = { spoken: [], cancels: 0 };
  globalRef.__e2eSpeech = state;

  class SpyUtterance implements UtteranceLike {
    text: string;
    lang = "";
    voice: unknown = null;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  }

  const synth = {
    speaking: false,
    pending: false,
    paused: false,
    speak(utterance: UtteranceLike): void {
      state.spoken.push({ text: utterance.text, lang: utterance.lang });
      // End on a later task so the fallback sets `current` before it settles.
      setTimeout(() => {
        try {
          utterance.onstart?.();
        } catch {
          /* the app treats a throwing listener as fatal-free */
        }
        try {
          utterance.onend?.();
        } catch {
          /* ignore */
        }
      }, 0);
    },
    cancel(): void {
      state.cancels += 1;
    },
    pause(): void {},
    resume(): void {},
    getVoices(): unknown[] {
      return [];
    },
    addEventListener(): void {},
    removeEventListener(): void {},
  };

  const define = (key: string, value: unknown): void => {
    const target = globalThis as unknown as Record<string, unknown>;
    try {
      Object.defineProperty(target, key, { configurable: true, value });
    } catch {
      target[key] = value;
    }
  };
  define("speechSynthesis", synth);
  define("SpeechSynthesisUtterance", SpyUtterance);
}

/** Read the spy's accumulated state from the page. */
export async function readSpeechSpy(page: Page): Promise<SpeechSpyState> {
  return page.evaluate(() => {
    const state = (globalThis as unknown as { __e2eSpeech?: SpeechSpyState })
      .__e2eSpeech;
    return state ?? { spoken: [], cancels: 0 };
  });
}
