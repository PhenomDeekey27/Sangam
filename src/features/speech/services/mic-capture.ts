/**
 * Microphone capture, independent of any recognition engine.
 *
 * `getUserMedia` grants access to the microphone and `MediaRecorder` encodes
 * the stream; neither performs speech recognition. This module only captures
 * and chunks audio — the server pipeline (or the browser recognizer) decides
 * what the audio means. It is deliberately injectable so tests never touch a
 * real device.
 */

/** One live capture: an open device plus a way to start emitting chunks. */
export interface MicCapture {
  /** Container/codec advertised to the provider, e.g. `audio/webm;codecs=opus`. */
  readonly mimeType: string;
  /** Begin emitting encoded chunks (each a self-consistent ArrayBuffer). */
  readonly start: (onChunk: (chunk: ArrayBuffer) => void) => void;
  readonly stop: () => void;
  /** Stop and release the device; safe to call twice. */
  readonly close: () => void;
}

/** Opens a capture device; the single seam tests replace. */
export interface MicCaptureFactory {
  readonly supported: () => boolean;
  readonly open: () => Promise<MicCapture>;
}

/** Codec preference order; the first the browser accepts wins. */
export const MIC_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
] as const;

/** Chunk cadence: frequent enough for interim transcripts, small enough to relay. */
export const MIC_TIMESLICE_MS = 250;

function pickMimeType(): string {
  const Recorder = (
    globalThis as unknown as { MediaRecorder?: typeof MediaRecorder }
  ).MediaRecorder;
  if (!Recorder || typeof Recorder.isTypeSupported !== "function") return "";
  return (
    MIC_MIME_CANDIDATES.find((candidate) =>
      Recorder.isTypeSupported(candidate),
    ) ?? ""
  );
}

/** True when this browser can capture microphone audio at all. */
export function isMicCaptureSupported(): boolean {
  if (typeof navigator === "undefined") return false;
  const mediaDevices = navigator.mediaDevices as MediaDevices | undefined;
  const hasRecorder =
    typeof (globalThis as unknown as { MediaRecorder?: unknown })
      .MediaRecorder === "function";
  return Boolean(mediaDevices?.getUserMedia) && hasRecorder;
}

/** Wrap an open stream in a start/stop recorder lifecycle. */
export function createRecorderCapture(
  stream: MediaStream,
  mimeType: string,
): MicCapture {
  let recorder: MediaRecorder | null = null;

  const stopDevice = (): void => {
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* already stopped */
      }
    }
  };

  return {
    mimeType,
    start(onChunk) {
      const options: MediaRecorderOptions | undefined = mimeType
        ? { mimeType }
        : undefined;
      const next = new MediaRecorder(stream, options);
      recorder = next;
      next.ondataavailable = (event: BlobEvent) => {
        if (!event.data || event.data.size === 0) return;
        void event.data.arrayBuffer().then(onChunk);
      };
      next.start(MIC_TIMESLICE_MS);
    },
    stop() {
      const current = recorder;
      recorder = null;
      if (!current) return;
      try {
        if (current.state !== "inactive") current.stop();
      } catch {
        /* already stopping */
      }
    },
    close() {
      this.stop();
      stopDevice();
    },
  };
}

/** The real device factory: `getUserMedia` + `MediaRecorder`. */
export const browserMicCapture: MicCaptureFactory = {
  supported: isMicCaptureSupported,
  async open() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return createRecorderCapture(stream, pickMimeType());
  },
};
