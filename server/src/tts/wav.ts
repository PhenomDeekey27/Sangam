/**
 * Minimal WAV container utilities for the text-to-speech stage.
 *
 * Sarvam returns one complete WAV per request, and one translation can exceed
 * the vendor's per-request character ceiling, so several WAVs must be joined
 * into the single self-describing container the socket contract promises.
 * Only the pieces needed for that are implemented: read a RIFF/WAVE file's
 * canonical PCM format plus its `data` payload, rebuild a 44-byte PCM header,
 * and concatenate compatible payloads.
 *
 * Everything is defensive: an input that is not a well-formed PCM WAV reads as
 * `null`, and incompatible formats refuse to merge rather than producing
 * unplayable bytes.
 */

/** Canonical PCM parameters plus the raw sample payload of one WAV. */
export interface WavParts {
  readonly channels: number;
  readonly sampleRate: number;
  readonly bitsPerSample: number;
  readonly data: Buffer;
}

/** Parse a PCM WAV; `null` for a non-WAV or malformed container. */
export function readWav(buffer: Buffer): WavParts | null {
  if (buffer.length < 44) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buffer.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let bitsPerSample: number | null = null;
  let data: Buffer | null = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > buffer.length) break; // truncated chunk: unusable
    if (id === "fmt " && size >= 16) {
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bitsPerSample = buffer.readUInt16LE(body + 14);
    } else if (id === "data") {
      data = buffer.subarray(body, body + size);
    }
    // RIFF chunks are word-aligned: an odd size is padded with one byte.
    offset = body + size + (size % 2);
  }
  if (
    channels === null ||
    sampleRate === null ||
    bitsPerSample === null ||
    data === null
  ) {
    return null;
  }
  return { channels, sampleRate, bitsPerSample, data };
}

/** Rebuild a 44-byte PCM WAV header around a raw sample payload. */
export function buildWav(parts: WavParts): Buffer {
  const blockAlign = parts.channels * (parts.bitsPerSample / 8);
  const byteRate = parts.sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + parts.data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(parts.channels, 22);
  header.writeUInt32LE(parts.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(parts.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(parts.data.length, 40);
  return Buffer.concat([header, parts.data]);
}

/**
 * Join compatible PCM WAVs into one; `null` when any input is malformed or the
 * formats disagree. A single input is returned untouched.
 */
export function mergeWav(buffers: readonly Buffer[]): Buffer | null {
  if (buffers.length === 0) return null;
  const first = buffers[0] as Buffer;
  if (buffers.length === 1) return readWav(first) ? first : null;
  const parts = buffers.map(readWav);
  const head = parts[0];
  if (!head) return null;
  const payloads: Buffer[] = [head.data];
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index];
    if (
      !part ||
      part.channels !== head.channels ||
      part.sampleRate !== head.sampleRate ||
      part.bitsPerSample !== head.bitsPerSample
    ) {
      return null;
    }
    payloads.push(part.data);
  }
  return buildWav({ ...head, data: Buffer.concat(payloads) });
}
