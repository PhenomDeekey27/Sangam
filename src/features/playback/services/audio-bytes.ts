/**
 * Normalize the binary audio argument across transports: WebSocket delivers
 * `ArrayBuffer`, long-polling may hand a `Blob`, and anything else is treated
 * as unusable rather than crashing the playback queue. A Blob resolves
 * through `onBlob` later; playback ordering is enforced by the queue's
 * `sequence`, never by arrival timing.
 */
export function normalizeAudioBytes(
  value: unknown,
  onBlob: (bytes: ArrayBuffer) => void,
): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    ) as ArrayBuffer;
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    void value
      .arrayBuffer()
      .then(onBlob)
      .catch(() => undefined);
    return null;
  }
  return null;
}
