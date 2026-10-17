/**
 * Deterministic provider doubles for the interruption suite.
 *
 * These implement the real server interfaces (`Translator`, `TtsProvider`), so
 * the production pipeline, ordering, and interruption safeguards run unchanged;
 * only the vendor legs are replaced. Nothing here reads credentials or touches
 * the network, and every output is a pure function of the request (plus the
 * test-controlled mode), so results are reproducible and cost zero.
 */
import type {
  Translator,
  TranslationRequest,
  TranslationResult,
} from "../../server/src/translation/translator.js";
import { TtsProviderError } from "../../server/src/tts/provider.js";
import type {
  TtsProvider,
  TtsRequest,
  TtsResult,
} from "../../server/src/tts/provider.js";

/**
 * Always-available translation that names the language pair in its output. The
 * text is unique per (text, target), which lets a test prove exactly which
 * target language a later utterance used.
 */
export class ScriptedTranslator implements Translator {
  readonly calls: TranslationRequest[] = [];

  reset(): void {
    this.calls.length = 0;
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    this.calls.push({ ...request });
    return {
      text: `${request.text} [${request.sourceLanguage}->${request.targetLanguage}]`,
      targetLanguage: request.targetLanguage,
    };
  }
}

/**
 * TTS mode:
 * - `immediate`     — resolve now with a long, audible WAV (default).
 * - `deferred`      — hold until `release()`, so the test can interleave an
 *                     interruption with an in-flight synthesis.
 * - `fail`          — reject immediately (provider outage).
 * - `fail-deferred` — hold until `release()`, then reject. Lets the test wait
 *                     until the translated text row has rendered before the
 *                     failure lands, so the browser fallback reads real text.
 */
export type TtsMode = "immediate" | "deferred" | "fail" | "fail-deferred";

export interface TtsCallLog {
  readonly text: string;
  readonly language: string;
  readonly atMs: number;
}

export class ControllableTtsProvider implements TtsProvider {
  readonly id = "mock" as const;
  /** Empty list = accept every language Sangam supports. */
  readonly languages: readonly string[] = [];
  /** Separate cache tag so cached audio is never confused between modes. */
  readonly cacheTag = "e2e-controllable-tts";
  readonly calls: TtsCallLog[] = [];

  private mode: TtsMode = "immediate";
  private durationMs = 4_000;
  private waiters: Array<() => void> = [];

  configure(next: { mode?: TtsMode; durationMs?: number }): void {
    if (next.mode) this.mode = next.mode;
    if (typeof next.durationMs === "number" && next.durationMs > 0) {
      this.durationMs = next.durationMs;
    }
  }

  get currentMode(): TtsMode {
    return this.mode;
  }

  get currentDurationMs(): number {
    return this.durationMs;
  }

  /** Syntheses currently held by `deferred`/`fail-deferred`. */
  get pending(): number {
    return this.waiters.length;
  }

  /** Forget call history and return to a clean `immediate` default. */
  reset(): void {
    this.calls.length = 0;
    this.mode = "immediate";
    this.waiters.length = 0;
  }

  /** Resolve every held synthesis; returns how many were released. */
  release(): number {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
    return waiters.length;
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    this.calls.push({
      text: request.text,
      language: request.language,
      atMs: Date.now(),
    });
    if (this.mode === "fail") {
      throw new TtsProviderError("unknown", "e2e scripted TTS failure");
    }
    if (this.mode === "deferred" || this.mode === "fail-deferred") {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    if (this.mode === "fail-deferred") {
      throw new TtsProviderError("unknown", "e2e deferred TTS failure");
    }
    return {
      audio: makeToneWav(this.durationMs / 1000, 24_000),
      mimeType: "audio/wav",
    };
  }
}

/**
 * A mono 16-bit PCM WAV of an audible tone. Long enough to still be playing
 * when the test triggers an interruption, and valid enough for a real
 * `<audio>` element to start, run, and report `ended`.
 */
export function makeToneWav(seconds: number, sampleRate: number): Buffer {
  const total = Math.max(1, Math.round(seconds * sampleRate));
  const pcm = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i += 1) {
    const value = Math.round(
      Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8_000,
    );
    pcm.writeInt16LE(value, i * 2);
  }
  return wrapPcmAsWav(pcm, sampleRate);
}

/** Wrap raw 16-bit mono PCM in a canonical 44-byte WAV header. */
export function wrapPcmAsWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
