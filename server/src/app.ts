import { createServer, type Server as HttpServer } from "node:http";
import cors from "cors";
import express from "express";
import { Server as SocketIOServer } from "socket.io";
import {
  loadEnv,
  resolveSpeechEnv,
  resolveTranslationEnv,
  resolveTtsEnv,
  type ServerEnv,
  type SpeechEnv,
  type TranslationEnv,
  type TtsEnv,
} from "./config/env.js";
import { RoomManager } from "./rooms/room-manager.js";
import { lookupRoomForJoin } from "./rooms/room-lookup.js";
import { SpeechSessions } from "./speech/speech-sessions.js";
import { createTranslator } from "./translation/translation-factory.js";
import type { ChainAttemptInfo, ChainFinalInfo, ChainProviderId } from "./translation/translation-chain.js";
import type { GoogleProviderEvent } from "./translation/google-translate-provider.js";
import { TranslationService } from "./translation/translation-service.js";
import type { Translator } from "./translation/translator.js";
import { createTtsProvider } from "./tts/provider-factory.js";
import type { TtsProvider } from "./tts/provider.js";
import { TtsService } from "./tts/tts-service.js";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "./sockets/contract.js";
import { registerSocketHandlers } from "./sockets/register-handlers.js";

/** How often empty rooms past their TTL are swept from memory. */
const SWEEP_INTERVAL_MS = 15_000;

export interface SangamServer {
  readonly env: ServerEnv;
  readonly httpServer: HttpServer;
  readonly io: SocketIOServer<ClientToServerEvents, ServerToClientEvents>;
  readonly rooms: RoomManager;
  /** Server-side speech pipeline; reports its provider capabilities. */
  readonly speech: SpeechSessions;
  /** Validated speech configuration (credentials stay server-side). */
  readonly speechEnv: SpeechEnv;
  /** Per-utterance translation fan-out (null when unconfigured). */
  readonly translations: TranslationService | null;
  /** Validated translation configuration (credentials stay server-side). */
  readonly translationEnv: TranslationEnv;
  /** Stage-6 playback fan-out (null-safe when no provider is configured). */
  readonly tts: TtsService | null;
  /** Validated text-to-speech configuration (credentials stay server-side). */
  readonly ttsEnv: TtsEnv;
  /** Start listening on the configured port. Rejects on bind failure. */
  listen(): Promise<void>;
  /** Stop accepting connections, close sockets, and clear timers. */
  close(): Promise<void>;
}

/**
 * Build the HTTP + Socket.IO server around one shared in-memory RoomManager.
 * Express only serves a health probe; all conversation traffic is Socket.IO.
 * CORS is restricted to the configured browser origins (never `*` in
 * production — enforced by `loadEnv`).
 */
/**
 * Optional full-stack test injection. `translator` overrides whatever the
 * environment resolves (including `null`, which disables translation), so
 * integration tests can script provider behavior without network access.
 */
export interface SangamServerOverrides {
  readonly translator?: Translator | null;
  /** Optional full-stack test injection of the playback provider. */
  readonly ttsProvider?: TtsProvider | null;
}

export function createSangamServer(
  env: ServerEnv = loadEnv(),
  overrides?: SangamServerOverrides,
): SangamServer {
  const rooms = new RoomManager();
  const speechEnv = resolveSpeechEnv(env.speech);
  const translationEnv = resolveTranslationEnv(env.translation);
  const translator =
    overrides && "translator" in overrides
      ? (overrides.translator ?? null)
      : createTranslator(translationEnv, {
          onAttempt: logChainAttempt,
          onFallbackStart: logFallbackStart,
          onFinal: logChainFinal,
          onPrimaryEvent: logPrimaryEvent,
        });
  const ttsEnv = resolveTtsEnv(env.tts);
  const ttsProvider =
    overrides && "ttsProvider" in overrides
      ? (overrides.ttsProvider ?? null)
      : createTtsProvider(ttsEnv);

  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: [...env.clientOrigins] }));
  app.get("/health", (_request, response) => {
    response.json({ ok: true, rooms: rooms.roomCount });
  });
  /*
   * Code-only join lookup: the join dialog pastes just the room code, so it
   * asks here for the creator's stored preferences and mirrors them for the
   * guest. Only two language codes and a seat count leave the server — the
   * same data an invite link already carries publicly. The join itself still
   * goes through the validated `room:join` socket contract, which remains
   * the authority on membership.
   */
  app.get("/api/rooms/:code", (request, response) => {
    const result = lookupRoomForJoin(rooms, request.params.code);
    if (!result.ok) {
      response.status(result.status).json({ ok: false, error: result.error });
      return;
    }
    response.json({
      ok: true,
      code: result.code,
      language: result.language,
      listeningLanguage: result.listeningLanguage,
      seatsTaken: result.seatsTaken,
    });
  });

  const httpServer = createServer(app);
  const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(
    httpServer,
    {
      cors: { origin: [...env.clientOrigins] },
      /*
       * Connection-state recovery stays off on purpose: a reconnecting client
       * performs the documented clean rejoin flow (`room:join` on `connect`)
       * instead of the server reviving a half-dead socket session.
       */
    },
  );
  // Stage-6 playback: translation completions are synthesized into speech and
  // delivered only to the listener. Without a provider it stays a no-op and
  // the translated text remains the only delivery.
  const tts = new TtsService(io, rooms, ttsProvider);
  const translations = new TranslationService(io, rooms, translator, tts);
  // Speech finals reuse the same fan-out: without this, Deepgram finals stay
  // `unavailable` forever (no invocation, no event, no failure row).
  const speech = new SpeechSessions(io, rooms, speechEnv, undefined, translations);
  registerSocketHandlers(io, rooms, speech, translations);

  const sweeper = setInterval(() => {
    rooms.sweepEmptyRooms();
    tts.sweep();
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  return {
    env,
    httpServer,
    io,
    rooms,
    speech,
    speechEnv,
    translations,
    translationEnv,
    tts,
    ttsEnv,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        httpServer.once("error", onError);
        httpServer.listen(env.port, () => {
          httpServer.off("error", onError);
          resolve();
        });
      }),
    close: async () => {
      clearInterval(sweeper);
      await new Promise<void>((resolve) => {
        io.close(() => resolve());
      });
    },
  };
}

/**
 * Safe per-attempt translation diagnostic: provider, outcome, failure
 * category, HTTP status, elapsed time, and language pair. Never includes
 * transcript text, keys, headers, or upstream bodies.
 */
function logChainAttempt(info: ChainAttemptInfo): void {
  if (process.env.NODE_ENV === "production") return;
  console.debug(
    `[sangam] translation attempt provider=${info.provider} ` +
      `ok=${info.ok ? "yes" : "no"} code=${info.code ?? "-"} ` +
      `status=${info.httpStatus ?? "?"} elapsedMs=${info.elapsedMs} ` +
      `${info.sourceLanguage}->${info.targetLanguage}`,
  );
}

/** Development-only: a chain member failed and the next provider is running. */
function logFallbackStart(next: ChainProviderId): void {
  if (process.env.NODE_ENV === "production") return;
  console.debug(`[sangam] translation fallback started -> ${next}`);
}

/**
 * Development-only: which provider supplied the final translation —
 * `sarvam`, `google`, `gemini`, or `none` (the original transcript stays
 * visible).
 */
function logChainFinal(info: ChainFinalInfo): void {
  if (process.env.NODE_ENV === "production") return;
  console.debug(
    `[sangam] final provider: ${info.provider} elapsedMs=${info.elapsedMs} ` +
      `${info.sourceLanguage}->${info.targetLanguage}`,
  );
}

/**
 * Development-only, redacted primary-endpoint stages: request start, HTTP
 * status, detected response format, extracted char count, or rejection
 * reason. Never transcript text, translation text, or credentials.
 */
function logPrimaryEvent(event: GoogleProviderEvent): void {
  if (process.env.NODE_ENV === "production") return;
  switch (event.stage) {
    case "request_started":
      console.debug(`[sangam] google request started ${event.sl}->${event.tl}`);
      return;
    case "http_status":
      console.debug(`[sangam] google HTTP status=${event.status}`);
      return;
    case "response_format":
      console.debug(`[sangam] google response format=${event.format}`);
      return;
    case "translation_extracted":
      console.debug(
        `[sangam] google translation extracted chars=${event.charCount}`,
      );
      return;
    case "response_rejected":
      console.debug(
        `[sangam] google response rejected: ${event.reason}`,
      );
      return;
  }
}
