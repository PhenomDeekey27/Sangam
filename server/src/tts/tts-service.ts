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
 *
 * Latency: each run is timed, and a bounded content cache (`language` plus
 * synthesized text) reuses audio already produced for an identical phrase.
 * The cache only ever returns the same deterministic bytes a provider call
 * would, so delivery, ordering, and interruption are unchanged; it merely
 * shortens the TTS leg for repeated phrases. The dominant remaining leg is
 * the provider round trip, which this service does not otherwise alter.
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
  /**
   * Total bytes of synthesized audio retained for repeated phrases. `0`
   * disables the cache. Eviction is oldest-first.
   */
  readonly cacheBytes?: number;
}

const DEFAULT_MAX_AUDIO_BYTES = 4_000_000;
const DEFAULT_CACHE_BYTES = 8_000_000;

/** One cached synthesis, keyed by target language plus exact text. */
interface CachedAudio {
  readonly audio: Buffer;
  readonly mimeType: string;
  readonly bytes: number;
}

export class TtsService {
  private readonly io: AppServer;
  private readonly rooms: RoomManager;
  private readonly provider: TtsProvider | null;
  private readonly maxAudioBytes: number;
  private readonly cacheBytes: number;
  /** room code -> utterance ids this service has already handled (or runs). */
  private readonly handled = new Map<string, Set<string>>();
  /** `language\0text` -> synthesized audio, oldest-first for eviction. */
  private readonly cache = new Map<string, CachedAudio>();
  private cachedBytes = 0;

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
    this.cacheBytes =
      typeof options.cacheBytes === "number" && options.cacheBytes >= 0
        ? Math.floor(options.cacheBytes)
        : DEFAULT_CACHE_BYTES;
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
    const startedAt = Date.now();
    const cached = this.readCache(language, text);
    if (cached) {
      const outcome = this.deliver(
        room,
        listener,
        utteranceId,
        language,
        cached,
      );
      logTtsDiagnostic({
        utteranceId,
        language,
        outcome: `cached_${outcome}`,
        bytes: cached.bytes,
        elapsedMs: Date.now() - startedAt,
      });
      return;
    }
    try {
      const result = await provider.synthesize({ text, language });
      const elapsedMs = Date.now() - startedAt;
      if (result.audio.byteLength > this.maxAudioBytes) {
        logTtsDiagnostic({
          utteranceId,
          language,
          outcome: "dropped_oversized",
          elapsedMs,
        });
        return;
      }
      this.writeCache(language, text, result);
      const outcome = this.deliver(room, listener, utteranceId, language, result);
      logTtsDiagnostic({
        utteranceId,
        language,
        outcome,
        bytes: result.audio.byteLength,
        elapsedMs,
      });
    } catch (error) {
      logTtsDiagnostic({
        utteranceId,
        language,
        outcome: `failed:${failureCode(error)}`,
        elapsedMs: Date.now() - startedAt,
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
  ): "delivered" | "dropped_gone" {
    // The listener may have left mid-synthesis: only a live member of *this*
    // room ever receives audio, mirroring the translation fan-out.
    const membership = this.rooms.membershipOf(listener.socketId);
    if (!membership || membership.code !== room.code) return "dropped_gone";
    const payload = {
      utteranceId,
      sequence: this.sequenceOf(room, utteranceId),
      language,
      mimeType: result.mimeType,
    };
    this.io
      .to(listener.socketId)
      .emit("conversation:playback", payload, toSocketAudio(result.audio));
    return "delivered";
  }

  /** Cached audio for this exact language+text, refreshing its recency. */
  private readCache(language: string, text: string): CachedAudio | null {
    if (this.cacheBytes === 0) return null;
    const key = cacheKey(language, text);
    const hit = this.cache.get(key);
    if (!hit) return null;
    // Re-insert so a hot phrase survives oldest-first eviction.
    this.cache.delete(key);
    this.cache.set(key, hit);
    return hit;
  }

  /** Store one successful synthesis under the byte budget; over-budget entries
   * that can never fit alone are simply not cached. */
  private writeCache(
    language: string,
    text: string,
    result: { readonly audio: Buffer; readonly mimeType: string },
  ): void {
    if (this.cacheBytes === 0) return;
    const bytes = result.audio.byteLength;
    if (bytes > this.cacheBytes) return;
    const key = cacheKey(language, text);
    const previous = this.cache.get(key);
    if (previous) {
      this.cachedBytes -= previous.bytes;
      this.cache.delete(key);
    }
    this.cache.set(key, { audio: result.audio, mimeType: result.mimeType, bytes });
    this.cachedBytes += bytes;
    this.evictCache();
  }

  /** Drop oldest entries until the cache fits its byte budget again. */
  private evictCache(): void {
    while (this.cachedBytes > this.cacheBytes) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) return;
      const entry = this.cache.get(oldest);
      this.cache.delete(oldest);
      if (entry) this.cachedBytes -= entry.bytes;
    }
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
 * language, delivered byte count, and elapsed time. Never includes transcript
 * text, audio content, or secrets.
 */
function logTtsDiagnostic(detail: {
  readonly utteranceId: string;
  readonly language: string;
  readonly outcome: string;
  readonly bytes?: number;
  readonly elapsedMs?: number;
}): void {
  if (process.env.NODE_ENV === "production") return;
  console.debug(
    `[sangam] playback ${detail.utteranceId} lang=${detail.language} ` +
      `outcome=${detail.outcome}` +
      (detail.bytes !== undefined ? ` bytes=${detail.bytes}` : "") +
      ` elapsedMs=${detail.elapsedMs ?? "?"}`,
  );
}

/** Cache key: target language plus exact synthesized text. */
function cacheKey(language: string, text: string): string {
  return `${language}\u0000${text}`;
}
