/**
 * Scripted test double for `TtsProvider`. Test-only: it never calls a vendor
 * and never invents audio on its own — every response (or failure) is
 * explicitly scripted, and success always returns a recognizable deterministic
 * fake-WAV so tests can assert the exact bytes that reached a client.
 */
import {
  TtsProviderError,
  type TtsProvider,
  type TtsRequest,
  type TtsResult,
  type TtsFailureCode,
} from "./provider.js";

export interface MockTtsScript {
  /** Language codes that synthesize successfully; empty means every code. */
  readonly languages?: readonly string[];
  /** Failures keyed by language code; thrown instead of resolving. */
  readonly failures?: Readonly<Record<string, TtsFailureCode>>;
  /**
   * When true, `synthesize` waits for `release()` instead of resolving from
   * the script — lets tests order completions and simulate disconnects.
   */
  readonly deferred?: boolean;
}

/**
 * Build a tiny valid WAV container whose PCM payload encodes the text length,
 * so a test can prove exactly which bytes were relayed without depending on
 * any real codec. Deterministic for a given text.
 */
export function fakeWavBytes(text: string, sampleRate = 24_000): Buffer {
  const pcm = Buffer.alloc(Math.max(1, text.length) * 2, 0);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export class MockTtsProvider implements TtsProvider {
  readonly id = "mock" as const;
  readonly languages: readonly string[];
  readonly calls: TtsRequest[] = [];
  private readonly script: MockTtsScript;
  private releaseWaiters: Array<() => void> = [];

  constructor(script: MockTtsScript = {}) {
    this.script = script;
    this.languages = script.languages ?? [];
  }

  /** Let all deferred syntheses proceed. */
  release(): void {
    const waiters = this.releaseWaiters;
    this.releaseWaiters = [];
    for (const waiter of waiters) waiter();
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    this.calls.push(request);
    if (this.script.deferred) {
      await new Promise<void>((resolve) => {
        this.releaseWaiters.push(resolve);
      });
    }
    const failure = this.script.failures?.[request.language];
    if (failure) {
      throw new TtsProviderError(failure, `mocked ${failure}`);
    }
    return { audio: fakeWavBytes(request.text), mimeType: "audio/wav" };
  }
}
