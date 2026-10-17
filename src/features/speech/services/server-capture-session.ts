/**
 * Server-backed capture session.
 *
 * The browser only captures audio (`getUserMedia` + `MediaRecorder`) and
 * streams encoded chunks to the Sangam server, which runs the speech-to-text
 * provider. Transcripts come back through the existing room events — the
 * speaker's interim via `speech:interim`, the partner's via
 * `conversation:interim`, and the final as a normal room utterance. Nothing
 * here knows which vendor is behind the server.
 */
import type { SpeechStartAck, SocketError } from "@/types/socket";
import type { RoomSocket } from "@/features/room/services/socket";
import type { SpeechError } from "@/features/speech/types";
import type { CaptureEvents } from "@/features/speech/services/capture-session";
import type { CaptureController } from "@/features/speech/types";
import {
  browserMicCapture,
  type MicCapture,
  type MicCaptureFactory,
} from "@/features/speech/services/mic-capture";
import { errorForMicFailure } from "@/features/speech/services/capture-errors";

export interface ServerCaptureOptions {
  readonly language: string;
  readonly events: CaptureEvents;
  /** Human-readable language name for user-facing notices. */
  readonly describeLanguage?: (code: string) => string;
  /** Room socket accessor; `null` while this client is not connected. */
  readonly getSocket: () => RoomSocket | null;
  /** Injectable device backend; defaults to the real browser APIs. */
  readonly capture?: MicCaptureFactory;
}

const UNAVAILABLE: SpeechError = {
  code: "speech_unavailable",
  message:
    "Server speech recognition is unavailable — use the text composer instead.",
};

function toSpeechError(error: SocketError): SpeechError {
  const kn: SpeechError["code"] = isKnownCode(error.code)
    ? (error.code as SpeechError["code"])
    : "unknown";
  return {
    code: kn,
    message: error.message || "Speech recognition failed.",
  };
}

function isKnownCode(code: string): boolean {
  return [
    "provider_unavailable",
    "provider_auth",
    "provider_network",
    "provider_quota",
    "provider_response",
    "audio_too_large",
    "speech_unavailable",
    "language_mismatch",
    "language_not_supported",
    "network",
    "not_supported",
  ].includes(code);
}

/**
 * One server-pipeline capture. Like `CaptureSession`, it is created on demand
 * and disposed on mic-off or unmount; late socket events after disposal are
 * ignored, so a stale session can never surface a result.
 */
export class ServerCaptureSession implements CaptureController {
  private readonly events: CaptureEvents;
  private readonly describeLanguage: (code: string) => string;
  private readonly getSocket: () => RoomSocket | null;
  private readonly factory: MicCaptureFactory;

  private language: string;
  private mic: MicCapture | null = null;
  private socket: RoomSocket | null = null;
  private disposed = false;
  private desired = false;
  private started = false;
  private sessionNotified = false;

  private readonly onInterim = (payload: {
    readonly text: string;
    readonly language: string;
  }): void => {
    if (this.disposed || !this.desired) return;
    this.events.onInterim(payload.text);
  };

  private readonly onProviderError = (payload: SocketError): void => {
    if (this.disposed) return;
    this.fail(toSpeechError(payload), payload.code === "provider_auth");
  };

  constructor(options: ServerCaptureOptions) {
    this.events = options.events;
    this.describeLanguage = options.describeLanguage ?? ((code) => code);
    this.getSocket = options.getSocket;
    this.factory = options.capture ?? browserMicCapture;
    this.language = options.language;
  }

  /** True while capture is wanted. */
  get running(): boolean {
    return this.desired;
  }

  start(): void {
    if (this.disposed || this.desired) return;
    const socket = this.getSocket();
    if (!socket || !socket.connected) {
      this.fail(UNAVAILABLE, false);
      return;
    }
    this.socket = socket;
    this.desired = true;
    this.started = false;
    this.sessionNotified = false;
    this.events.onCapturing(true);
    this.events.onError(null);
    this.events.onStatus("starting");
    this.events.onNotice("Requesting the microphone…");
    socket.on("speech:interim", this.onInterim);
    socket.on("speech:error", this.onProviderError);
    void this.openMic();
  }

  stop(): void {
    if (!this.desired && this.mic === null) return;
    this.desired = false;
    this.clearInterim();
    this.events.onNotice("Microphone off.");
    this.events.onStatus("stopping");
    this.mic?.stop();
    this.mic = null;
    this.socket?.emit("speech:stop");
    this.events.onStatus("idle");
    this.events.onCapturing(false);
  }

  dispose(): void {
    this.disposed = true;
    this.desired = false;
    this.mic?.close();
    this.mic = null;
    const socket = this.socket;
    if (socket) {
      socket.off("speech:interim", this.onInterim);
      socket.off("speech:error", this.onProviderError);
      if (this.started) socket.emit("speech:stop");
    }
    this.socket = null;
  }

  /**
   * A live language change cannot retarget an open server session: the server
   * authorises recognition against the seat's recorded language. The new value
   * applies to the next microphone start.
   */
  setLanguage(language: string): void {
    this.language = language;
  }

  private async openMic(): Promise<void> {
    let mic: MicCapture;
    try {
      mic = await this.factory.open();
    } catch (cause) {
      const error = errorForMicFailure(cause);
      this.fail(error, error.code === "permission_denied");
      return;
    }
    if (this.disposed || !this.desired) {
      mic.close();
      return;
    }
    this.mic = mic;
    this.openProvider(mic);
  }

  private openProvider(mic: MicCapture): void {
    const socket = this.socket;
    if (!socket) {
      this.fail(UNAVAILABLE, false);
      return;
    }
    socket.emit(
      "speech:start",
      { language: this.language, mimeType: mic.mimeType },
      (response: SpeechStartAck) => {
        if (this.disposed || !this.desired) return;
        if (!response.ok) {
          this.fail(toSpeechError(response.error), false);
          return;
        }
        this.handleStarted(mic);
      },
    );
  }

  private handleStarted(mic: MicCapture): void {
    this.started = true;
    this.events.onPermission("granted");
    this.events.onStatus("listening");
    if (!this.sessionNotified) {
      this.sessionNotified = true;
      this.events.onNotice(
        `Microphone on — speak in ${this.describeLanguage(this.language)}. Interim words appear live; finished sentences join the transcript.`,
      );
    }
    mic.start((chunk) => {
      if (this.disposed || !this.desired) return;
      this.socket?.emit("speech:audio", chunk);
    });
  }

  private fail(error: SpeechError, permissionHit: boolean): void {
    this.desired = false;
    this.mic?.close();
    this.mic = null;
    const socket = this.socket;
    if (socket) {
      socket.off("speech:interim", this.onInterim);
      socket.off("speech:error", this.onProviderError);
    }
    if (this.disposed) return;
    if (permissionHit) this.events.onPermission("denied");
    this.events.onError(error);
    this.events.onNotice(error.message);
    this.events.onStatus("error");
    this.events.onCapturing(false);
  }

  private clearInterim(): void {
    this.events.onInterim("");
  }
}
