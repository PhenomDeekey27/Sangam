/**
 * Per-utterance speech playback fan-out (Stage 6). For each *completed*
 * translation the service synthesizes audio in the listener's target language
 * and delivers the reserved `conversation:playback` event to that recipient —
 * never to the speaker, never to the room channel.
 *
 * Ordering and duplication guarantees:
 * - Called only after the translation has landed on the stored row, so the
 *   transcript text always exists before (or without) its audio.
 * - One synthesis per utterance id per room (dedup set filled *before* the
   provider call), so a repeated invocation — reconnect replay, duplicate
 *   event, or a racing caller — can never trigger a second delivery.
 * - The emitted payload carries the server-stamped utterance `sequence`, so
 *   clients can queue playback in message order and discard stale audio.
 * - History replays never carry audio; only a live listener socket receives
 *   it. If the listener leaves during synthesis, the result is dropped
 *   silently — the translated text row survives either way.
 */
import type { Server } from "socket.io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "../sockets/contract.js";
import type { RoomManager } from "../rooms/room-manager.js";
import type { Room, RoomParticipant } from "../rooms/room-types.js";
import { isLanguageCode, normalizeLanguage } from "../rooms/room-validation.js";
import type { TtsProvider } from "./provider.js";

type AppServer = Server<ClientToServerEvents, ServerToClientEvents>;

/** A completed translation, as stored on the transcript row. */
export interface CompletedTranslation {
  readonly text: string;
  readonly targetLanguage: string;
}

export interface TtsServiceOptions {
  /** Hard ceiling on relayed audio bytes; oversized results are dropped. */
  readonly maxAudioBytes?: number;
}

const DEFAULT_MAX_AUDIO_BYTES = 4_000_000;

export class TtsService {
  private readonly io: AppServer;
  private readonly rooms: RoomManager;
  private readonly provider: TtsProvider | null;
  private readonly maxAudioBytes: number;
  /** room code -> utterance ids this service has already handled (or runs). */
  private readonly handled = new Map<string, Set<string>>();

  constructor(
    io: AppServer,
    rooms: RoomManager,
    provider: TtsProvider | null,
    options: TtsServiceOptions = {},
  ) {
    this.io = io;
    this.rooms = rooms;
    this.provider = provider;
    this.maxAudioBytes =
      typeof options.maxAudioBytes === "number" && options.maxAudioBytes > 0
        ? Math.floor(options.maxAudioBytes)
        : DEFAULT_MAX_AUDIO_BYTES;
  }

  /**
   * Speak one completed translation for its listener. Fire-and-forget:
   * resolves nothing and never rejects — a failure simply leaves the row's
   * translated text without audio.
   */
  speakForListener(
    room: Room,
    listener: RoomParticipant,
    utteranceId: string,
    translation: CompletedTranslation,
  ): void {
    if (!this.provider) return;
    const language = normalizeLanguage(translation.targetLanguage ?? "");
    if (!isLanguageCode(language)) {
      logTtsDiagnostic({ utteranceId, language, outcome: "skipped_bad_language" });
      return;
    }
    // Dedup before synthesis so even an in-flight run blocks a repeat.
    if (!this.claim(room, utteranceId)) return;
    void this.run(room, listener, utteranceId, language, translation.text).catch(
      () => {
        // `run` records every failure; this is unreachable backup.
      },
    );
  }

  /**
   * Drop per-room dedup state for rooms that no longer exist, so a
   * long-lived server does not accumulate keys for swept rooms. Called from
   * the same interval that sweeps empty rooms.
   */
  sweep(): void {
    for (const code of [...this.handled.keys()]) {
      if (!this.rooms.roomByCode(code)) this.handled.delete(code);
    }
  }

  /** Mark the utterance handled; `false` when it was already claimed. */
  private claim(room: Room, utteranceId: string): boolean {
    let set = this.handled.get(room.code);
    if (!set) {
      set = new Set();
      this.handled.set(room.code, set);
    }
    if (set.has(utteranceId)) return false;
    set.add(utteranceId);
    return true;
  }

  private async run(
    room: Room,
    listener: RoomParticipant,
    utteranceId: string,
    language: string,
    text: string,
  ): Promise<void> {
    const provider = this.provider;
    if (!provider) return;
    if (provider.languages.length > 0 && !provider.languages.includes(language)) {
      logTtsDiagnostic({ utteranceId, language, outcome: "skipped_language" });
      return;
    }
    try {
      const result = await provider.synthesize({ text, language });
      if (result.audio.byteLength > this.maxAudioBytes) {
        logTtsDiagnostic({
          utteranceId,
          language,
          outcome: "dropped_oversized",
        });
        return;
      }
      this.deliver(room, listener, utteranceId, language, result);
    } catch (error) {
      logTtsDiagnostic({
        utteranceId,
        language,
        outcome: `failed:${failureCode(error)}`,
      });
    }
  }

  /** Relay the audio to the listener's socket, if they are still seated here. */
  private deliver(
    room: Room,
    listener: RoomParticipant,
    utteranceId: string,
    language: string,
    result: { readonly audio: Buffer; readonly mimeType: string },
  ): void {
    // The listener may have left mid-synthesis: only a live member of *this*
    // room ever receives audio, mirroring the translation fan-out.
    const membership = this.rooms.membershipOf(listener.socketId);
    if (!membership || membership.code !== room.code) {
      logTtsDiagnostic({ utteranceId, language, outcome: "dropped_gone" });
      return;
    }
    const payload = {
      utteranceId,
      sequence: this.sequenceOf(room, utteranceId),
      language,
      mimeType: result.mimeType,
    };
    this.io
      .to(listener.socketId)
      .emit("conversation:playback", payload, toSocketAudio(result.audio));
    logTtsDiagnostic({
      utteranceId,
      language,
      outcome: "delivered",
      bytes: result.audio.byteLength,
    });
  }

  /** The stored row's ordering stamp; `0` when the row vanished (defensive). */
  private sequenceOf(room: Room, utteranceId: string): number {
    const stored = room.transcript.find((row) => row.utterance.id === utteranceId);
    return stored?.utterance.sequence ?? 0;
  }
}

/**
 * Copy a pooled Buffer into a standalone ArrayBuffer so Socket.IO relays it
 * as one binary attachment without sharing Node pool memory.
 */
function toSocketAudio(audio: Buffer): ArrayBuffer {
  const bytes = new Uint8Array(audio.byteLength);
  bytes.set(audio);
  return bytes.buffer;
}

function failureCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return "unknown";
}

/**
 * Safe development diagnostic for each playback stage: invocation outcome,
 * language, and delivered byte count. Never includes transcript text,
 * audio content, or secrets.
 */
function logTtsDiagnostic(detail: {
  readonly utteranceId: string;
  readonly language: string;
  readonly outcome: string;
  readonly bytes?: number;
}): void {
  if (process.env.NODE_ENV === "production") return;
  console.debug(
    `[sangam] playback ${detail.utteranceId} lang=${detail.language} ` +
      `outcome=${detail.outcome}` +
      (detail.bytes !== undefined ? ` bytes=${detail.bytes}` : ""),
  );
}
