/**
 * Per-utterance translation fan-out. For each finalized utterance the service
 * translates the original text for the *listener* and delivers the existing
 * reserved `conversation:translation` event to that recipient. The target is
 * the listener's stored listening language, falling back to the language the
 * listener speaks when the room holds mirrored pairs (where listening always
 * equals the incoming source and would otherwise skip every utterance).
 *
 * Ordering guarantees:
 * - The original transcript is broadcast by the caller *before* this runs,
 *   so translation can never delay or reorder the transcript.
 * - Finals only: interims never reach this service.
 * - One translation per utterance id (in-flight set plus a stored-state
 *   check), applied by id lookup so stale or out-of-order completions land
 *   on the right row or are dropped.
 * - Completions mutate the stored history row in place, so a later history
 *   replay carries the latest translation. If the recipient left, the result
 *   is still persisted when the room exists; nothing is emitted to a gone
 *   socket and the handler never throws.
 */
import type { Server } from "socket.io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "../sockets/contract.js";
import type { RoomManager } from "../rooms/room-manager.js";
import type { Room, RoomTranscriptEntry } from "../rooms/room-types.js";
import { isLanguageCode, normalizeLanguage } from "../rooms/room-validation.js";
import type { Translator } from "./translator.js";
import type { TranslationErrorCode } from "../../../src/features/translation/types/index.js";
import type { TtsService } from "../tts/tts-service.js";

type AppServer = Server<ClientToServerEvents, ServerToClientEvents>;

interface FailedTranslation {
  readonly status: "failed";
  readonly error: {
    readonly code: TranslationErrorCode;
    readonly message: string;
  };
}

export class TranslationService {
  private readonly io: AppServer;
  private readonly rooms: RoomManager;
  private readonly translator: Translator | null;
  /** Stage-6 playback; synthesizes the completed translation for the listener. */
  private readonly tts: TtsService | null;
  private readonly inFlight = new Set<string>();

  constructor(
    io: AppServer,
    rooms: RoomManager,
    translator: Translator | null,
    tts: TtsService | null = null,
  ) {
    this.io = io;
    this.rooms = rooms;
    this.translator = translator;
    this.tts = tts;
  }

  /**
   * Translate one finalized utterance for its listener. Fire-and-forget:
   * resolves nothing and never rejects — failures are recorded on the row.
   */
  translateUtterance(room: Room, entry: RoomTranscriptEntry): void {
    if (!this.translator) return;
    void this.run(room, entry).catch(() => {
      // `run` records every failure on the row; this is unreachable backup.
    });
  }

  private async run(room: Room, entry: RoomTranscriptEntry): Promise<void> {
    const translator = this.translator;
    if (!translator) return;
    const utteranceId = entry.utterance.id;
    const key = `${room.code}:${utteranceId}`;
    if (this.inFlight.has(key)) return;

    const recipient = this.listener(room, entry.utterance.speakerSide);
    if (!recipient) {
      logTranslationDiagnostic({
        utteranceId,
        source: normalizeLanguage(entry.utterance.language ?? ""),
        target: "?",
        outcome: "skipped_no_listener",
        translated: false,
      });
      return;
    }
    const source = normalizeLanguage(entry.utterance.language ?? "");
    const preferred = normalizeLanguage(recipient.listeningLanguage ?? "");
    if (!isLanguageCode(source) || !isLanguageCode(preferred)) {
      logTranslationDiagnostic({
        utteranceId,
        source,
        target: preferred,
        outcome: "skipped_bad_language",
        translated: false,
      });
      return;
    }
    /*
     * Translation target: the listener's stored listening language. When the
     * room holds mirrored pairs (a:en/ta, b:ta/en) the listener's listening
     * language always equals the incoming source, which would skip every
     * utterance. Fall back to the language the listener actually speaks —
     * identical to listening in same-per-seat rooms, so those are unaffected.
     */
    const spoken = normalizeLanguage(recipient.language ?? "");
    const target = preferred !== source ? preferred : spoken;
    if (!isLanguageCode(target)) {
      logTranslationDiagnostic({
        utteranceId,
        source,
        target,
        outcome: "skipped_bad_language",
        translated: false,
      });
      return;
    }
    // Same language both sides: nothing to translate and no call to bill.
    if (source === target) {
      logTranslationDiagnostic({
        utteranceId,
        source,
        target,
        outcome: "skipped_same_language",
        translated: false,
        detail:
          `speakerSide=${entry.utterance.speakerSide} ` +
          `listenerSide=${recipient.side} seats=${seatSummary(room)}`,
      });
      return;
    }
    if (!this.isPending(room, utteranceId)) return;

    this.inFlight.add(key);
    const startedAt = Date.now();
    logTranslationDiagnostic({
      utteranceId,
      source,
      target,
      outcome: "invoked",
      translated: false,
    });
    try {
      const result = await translator.translate({
        text: entry.utterance.text,
        sourceLanguage: source,
        targetLanguage: target,
      });
      const stored = this.pendingRow(room, utteranceId);
      if (!stored) return;
      const translation = {
        status: "complete" as const,
        text: result.text,
        targetLanguage: result.targetLanguage,
      };
      stored.translation = translation;
      logTranslationDiagnostic({
        utteranceId,
        source,
        target,
        outcome: "complete",
        elapsedMs: Date.now() - startedAt,
        translated: result.text.length > 0,
      });
      this.emitToListener(room, recipient.socketId, utteranceId, translation);
      // Playback (Stage 6) rides the completed translation: the text row is
      // already stored and delivered, so a synthesis failure loses nothing.
      this.tts?.speakForListener(room, recipient, utteranceId, {
        text: result.text,
        targetLanguage: result.targetLanguage,
      });
    } catch (error) {
      const stored = this.pendingRow(room, utteranceId);
      if (!stored) return;
      const translation: FailedTranslation = {
        status: "failed",
        error: toSafeError(error),
      };
      stored.translation = translation;
      logTranslationDiagnostic({
        utteranceId,
        source,
        target,
        outcome: `failed:${translation.error.code}`,
        elapsedMs: Date.now() - startedAt,
        translated: false,
      });
      this.emitToListener(room, recipient.socketId, utteranceId, translation);
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** The other seat's participant, if the room currently has one. */
  private listener(room: Room, speakerSide: string) {
    for (const participant of room.participants.values()) {
      if (participant.side !== speakerSide) return participant;
    }
    return null;
  }

  private isPending(room: Room, utteranceId: string): boolean {
    return this.pendingRow(room, utteranceId) !== null;
  }

  private pendingRow(
    room: Room,
    utteranceId: string,
  ): RoomTranscriptEntry | null {
    const stored =
      room.transcript.find((row) => row.utterance.id === utteranceId) ?? null;
    if (!stored || stored.translation.status !== "unavailable") return null;
    return stored;
  }

  private emitToListener(
    room: Room,
    socketId: string,
    utteranceId: string,
    translation:
      | {
          readonly status: "complete";
          readonly text: string;
          readonly targetLanguage: string;
        }
      | FailedTranslation,
  ): void {
    // The recipient may have disconnected mid-translation: the history row
    // above already keeps the result, so only emit to a live member.
    const membership = this.rooms.membershipOf(socketId);
    if (!membership || membership.code !== room.code) return;
    this.io
      .to(socketId)
      .emit("conversation:translation", { utteranceId, translation });
  }
}

/** Map provider failures to safe, non-sensitive client statuses. */
function toSafeError(error: unknown): FailedTranslation["error"] {
  const code = toErrorCode(error);
  switch (code) {
    case "network":
      return {
        code: "network",
        message:
          "Translation failed — showing the original. Check the connection and keep talking.",
      };
    case "timeout":
      return {
        code: "timeout",
        message:
          "Translation timed out — showing the original. Keep talking; the next line will retry.",
      };
    case "unsupported":
      return {
        code: "unsupported_language",
        message:
          "This language pair is not supported for translation — showing the original.",
      };
    default:
      return {
        code:
          code === "auth" || code === "rate_limited"
            ? "provider_error"
            : "unknown",
        message: "Translation failed — showing the original.",
      };
  }
}

function toErrorCode(
  error: unknown,
): "network" | "timeout" | "rate_limited" | "unsupported" | "auth" | "unknown" {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    const code = (error as { code: string }).code;
    if (
      code === "network" ||
      code === "timeout" ||
      code === "rate_limited" ||
      code === "unsupported" ||
      code === "auth"
    ) {
      return code;
    }
  }
  return "unknown";
}

/**
 * Safe development diagnostic for each translation stage: invocation,
 * source/target codes, outcome category, elapsed time, and whether a
 * non-empty translation was returned. Never includes text or secrets.
 */
function logTranslationDiagnostic(detail: {
  readonly utteranceId: string;
  readonly source: string;
  readonly target: string;
  readonly outcome: string;
  readonly elapsedMs?: number;
  readonly translated: boolean;
  readonly detail?: string;
}): void {
  if (process.env.NODE_ENV === "production") return;
  console.debug(
    `[sangam] translate ${detail.utteranceId} ${detail.source}->${detail.target} ` +
      `outcome=${detail.outcome} ` +
      `elapsedMs=${detail.elapsedMs ?? "?"} ` +
      `translated=${detail.translated ? "yes" : "no"}` +
      (detail.detail ? ` ${detail.detail}` : ""),
  );
}

/** Compact seat summary for diagnostics: `side:speaking/listening`. */
function seatSummary(room: Room): string {
  return [...room.participants.values()]
    .map(
      (p) =>
        `${p.side}:${normalizeLanguage(p.language)}/${normalizeLanguage(p.listeningLanguage ?? "")}`,
    )
    .join(",");
}
