/**
 * Deterministic fake-microphone audio for the browser capture path.
 *
 * Chromium's `--use-file-for-fake-audio-capture` flag loops a real WAV file as
 * if it came from a device, so the app's `getUserMedia` → `MediaRecorder`
 * pipeline runs for real. The content is a synthetic two-tone signal: valid
 * 16-bit PCM audio, reproducible byte-for-byte, with no external fixture to
 * download and no recorded voice to leak.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SpeechWavOptions {
  readonly seconds?: number;
  readonly sampleRate?: number;
}

/** Build the fixture bytes (mono, 16-bit PCM, two tones under an envelope). */
export function buildSpeechWav(options: SpeechWavOptions = {}): Buffer {
  const sampleRate = options.sampleRate ?? 16_000;
  const seconds = options.seconds ?? 2.5;
  const total = Math.max(1, Math.round(seconds * sampleRate));
  const pcm = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i += 1) {
    const t = i / sampleRate;
    const carrier =
      0.4 * Math.sin(2 * Math.PI * 220 * t) +
      0.3 * Math.sin(2 * Math.PI * 660 * t);
    const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * 2 * t);
    pcm.writeInt16LE(Math.round(carrier * envelope * 12_000), i * 2);
  }
  return Buffer.concat([wavHeader(pcm.length, sampleRate), pcm]);
}

function wavHeader(dataBytes: number, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/** Write the fixture to `filePath`, creating parent directories as needed. */
export function writeSpeechFixture(filePath: string): void {
  const wav = buildSpeechWav();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, wav);
  console.log(
    `[e2e] wrote ${wav.length}-byte microphone fixture -> ${filePath}`,
  );
}
