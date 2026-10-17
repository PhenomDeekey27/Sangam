/**
 * One server-side recognition session per socket, and the registry that owns
 * them. A session is authorised against live room membership, opened with an
 * explicitly supplied speaking language, fed captured audio under a hard byte
 * ceiling, and torn down the moment the member leaves or disconnects.
 *
 * Transcripts reuse the existing room architecture: interim lines relay as
 * `conversation:interim` to the partner (and `speech:interim` to the speaker),
 * and a final becomes a normal room utterance so ordering, history replay, and
 * de-duplication keep working unchanged.
 */
import { randomUUID } from "node:crypto";
import type { Server, Socket } from "socket.io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketError,
  SpeechCapabilities,
} from "../../../src/types/socket.js";
import type { RoomManager } from "../rooms/room-manager.js";
import type { RoomTranscriptEntry } from "../rooms/room-types.js";
import { isLanguageCode, normalizeLanguage } from "../rooms/room-validation.js";
import { channelFor } from "../sockets/room-handlers.js";
import type {
  SpeechProvider,
  SpeechProviderError,
  SpeechProviderSession,
} from "./provider.js";
import type { TranslationService } from "../translation/translation-service.js";
import type { SpeechEnv } from "../config/env.js";
import { createSpeechProvider } from "./provider-factory.js";

type AppServer = Server<ClientToServerEvents, ServerToClientEvents>;
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

/** Largest single audio chunk accepted (protects the event loop). */
export const MAX_CHUNK_BYTES = 1_000_000;
/** Identical finals inside this window are treated as provider repeats. */
export const DUPLICATE_FINAL_WINDOW_MS = 2_000;

/**
 * Container formats the pipeline accepts. The server never decodes audio; it
 * only rejects obviously wrong metadata so a client cannot claim video or a
 * huge opaque blob as speech.
 */
export const ALLOWED_MIME_TYPES = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
] as const;

export function isAllowedMimeType(value: unknown): boolean {
  if (value === undefined || value === null) return true; // provider auto-detect
  if (typeof value !== "string") return false;
  const base = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(base);
}

export interface SpeechSessionError {
  readonly code: string;
  readonly message: string;
}

interface ActiveSession {
  language: string;
  session: SpeechProviderSession | null;
  bytes: number;
  lastFinal: { text: string; at: number } | null;
  closed: boolean;
  /** Local clock marks for development latency diagnostics only. */
  startedAt: number;
  lastChunkAt: number | null;
}

function toSocketError(error: SpeechProviderError): SocketError {
  return { code: error.code, message: error.message };
}

export class SpeechSessions {
  private readonly io: AppServer;
  private readonly rooms: RoomManager;
  private readonly provider: SpeechProvider;
  private readonly maxSessionBytes: number;
  private readonly translations: TranslationService | null;
  private readonly active = new Map<string, ActiveSession>();

  constructor(
    io: AppServer,
    rooms: RoomManager,
    speech: SpeechEnv,
    provider: SpeechProvider = createSpeechProvider(speech),
    translations: TranslationService | null = null,
  ) {
    this.io = io;
    this.rooms = rooms;
    this.provider = provider;
    this.maxSessionBytes = speech.maxSessionBytes;
    this.translations = translations;
  }

  capabilities(): SpeechCapabilities {
    return {
      provider: this.provider.id,
      streaming: this.provider.streaming,
      interim: this.provider.interim,
      languages: this.provider.languages,
    };
  }

  /**
   * Open a session for a seated member. Returns a structured refusal instead of
   * throwing so the caller can ack the client.
   */
  start(
    socket: AppSocket,
    request: { language?: unknown; mimeType?: unknown },
  ):
    | { readonly ok: true; readonly language: string }
    | { readonly ok: false; readonly error: SpeechSessionError } {
    const membership = this.rooms.membershipOf(socket.id);
    const participant = this.rooms.participantOf(socket.id);
    if (!membership || !participant) {
      return {
        ok: false,
        error: { code: "not_in_room", message: "Join the room first." },
      };
    }
    if (this.provider.id === "none") {
      return {
        ok: false,
        error: {
          code: "speech_unavailable",
          message: "Server speech recognition is not configured.",
        },
      };
    }
    if (!isLanguageCode(request.language)) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: "A supported speaking language is required.",
        },
      };
    }
    if (
      this.provider.languages.length > 0 &&
      !this.provider.languages.includes(normalizeLanguage(request.language))
    ) {
      return {
        ok: false,
        error: {
          code: "language_not_supported",
          message:
            "The server speech provider does not support this speaking language — type your message instead.",
        },
      };
    }
    if (!isAllowedMimeType(request.mimeType)) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: "Unsupported audio format.",
        },
      };
    }
    const language = normalizeLanguage(request.language);
    // The seat's stored speaking language is authoritative: a client cannot
    // start recognition in a language the room did not record for it.
    if (language !== participant.language) {
      return {
        ok: false,
        error: {
          code: "language_mismatch",
          message: `This seat speaks ${participant.language}.`,
        },
      };
    }

    this.release(socket.id);
    const active = this.createActive(language);
    this.active.set(socket.id, active);
    active.session = this.provider.open({
      language,
      onInterim: (text) => this.handleInterim(socket, active, text),
      onFinal: (text) => this.handleFinal(socket, active, text),
      onError: (error) => this.fail(socket, active, error),
      onClose: () => {},
    });
    return { ok: true, language };
  }

  /** Forward one captured chunk, enforcing the per-session ceiling. */
  push(socket: AppSocket, chunk: unknown): void {
    const active = this.active.get(socket.id);
    if (!active || active.closed) return;
    const bytes = byteLength(chunk);
    if (bytes === 0) return;
    if (
      bytes > MAX_CHUNK_BYTES ||
      active.bytes + bytes > this.maxSessionBytes
    ) {
      this.fail(socket, active, {
        code: "audio_too_large",
        message:
          "The recording limit for one turn was reached — it has been stopped.",
        retryable: true,
      });
      return;
    }
    active.bytes += bytes;
    active.lastChunkAt = Date.now();
    active.session?.push(new Uint8Array(chunk as ArrayBufferLike));
  }

  /** Graceful stop: a final segment may still flush. */
  stop(socket: AppSocket): void {
    const active = this.active.get(socket.id);
    if (!active) return;
    active.session?.stop();
  }

  /** Release a socket's session outright; no event fires afterwards. */
  release(socketId: string): void {
    const active = this.active.get(socketId);
    if (!active) return;
    this.active.delete(socketId);
    active.closed = true;
    active.session?.close();
    active.session = null;
  }

  private createActive(language: string): ActiveSession {
    return {
      language,
      session: null,
      bytes: 0,
      lastFinal: null,
      closed: false,
      startedAt: Date.now(),
      lastChunkAt: null,
    };
  }

  private handleInterim(
    socket: AppSocket,
    active: ActiveSession,
    text: string,
  ): void {
    if (active.closed || !this.stillMember(socket)) return;
    const trimmed = text.trim();
    socket.emit("speech:interim", { text: trimmed, language: active.language });
    const membership = this.rooms.membershipOf(socket.id);
    if (!membership) return;
    socket.to(channelFor(membership.code)).emit("conversation:interim", {
      side: this.sideOf(socket),
      text: trimmed,
      language: active.language,
    });
  }

  private handleFinal(
    socket: AppSocket,
    active: ActiveSession,
    text: string,
  ): void {
    if (active.closed) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const now = Date.now();
    const previous = active.lastFinal;
    if (
      previous &&
      previous.text === trimmed &&
      now - previous.at < DUPLICATE_FINAL_WINDOW_MS
    ) {
      return;
    }
    active.lastFinal = { text: trimmed, at: now };

    const membership = this.rooms.membershipOf(socket.id);
    const participant = this.rooms.participantOf(socket.id);
    const room = this.rooms.roomOf(socket.id);
    if (!membership || !participant || !room) return;

    room.utteranceSeq += 1;
    const entry: RoomTranscriptEntry = {
      utterance: {
        id: randomUUID(),
        speakerSide: participant.side,
        language: active.language,
        text: trimmed,
        finalizedAt: now,
        sequence: room.utteranceSeq,
      },
      translation: { status: "unavailable" },
    };
    this.rooms.recordUtterance(room, entry);
    logSpeechDiagnostic({
      utteranceId: entry.utterance.id,
      language: active.language,
      chars: trimmed.length,
      bytes: active.bytes,
      sinceStartMs: now - active.startedAt,
      sinceLastChunkMs:
        active.lastChunkAt === null ? null : now - active.lastChunkAt,
    });
    // Clear the speaker's own interim line; the partner's clears on the row.
    socket.emit("speech:interim", { text: "", language: active.language });
    this.io
      .to(channelFor(membership.code))
      .emit("conversation:utterance", { entry });
    // Translate after broadcasting: the original is never delayed by the
    // provider, and the translation updates this same row by utterance id.
    this.translations?.translateUtterance(room, entry);
  }

  private fail(
    socket: AppSocket,
    active: ActiveSession,
    error: SpeechProviderError,
  ): void {
    if (active.closed) return;
    this.release(socket.id);
    socket.emit("speech:error", toSocketError(error));
  }

  private stillMember(socket: AppSocket): boolean {
    return this.rooms.membershipOf(socket.id) !== null;
  }

  private sideOf(socket: AppSocket) {
    return this.rooms.participantOf(socket.id)?.side ?? "a";
  }
}

function byteLength(chunk: unknown): number {
  if (chunk instanceof ArrayBuffer) return chunk.byteLength;
  if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
  return 0;
}

/**
 * Development-only speech timing: how long one finalized turn took from its
 * session's start and from its last audio chunk. Contains ids, language, and
 * counts only — never the transcript text or the audio.
 */
function logSpeechDiagnostic(detail: {
  readonly utteranceId: string;
  readonly language: string;
  readonly chars: number;
  readonly bytes: number;
  readonly sinceStartMs: number;
  readonly sinceLastChunkMs: number | null;
}): void {
  if (process.env.NODE_ENV === "production") return;
  console.debug(
    `[sangam] speech final ${detail.utteranceId} lang=${detail.language} ` +
      `chars=${detail.chars} bytes=${detail.bytes} ` +
      `sinceStartMs=${detail.sinceStartMs} ` +
      `sinceLastChunkMs=${detail.sinceLastChunkMs ?? "?"}`,
  );
}
