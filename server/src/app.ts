import { createServer, type Server as HttpServer } from "node:http";
import cors from "cors";
import express from "express";
import { Server as SocketIOServer } from "socket.io";
import {
  loadEnv,
  resolveSpeechEnv,
  type ServerEnv,
  type SpeechEnv,
} from "./config/env.js";
import { RoomManager } from "./rooms/room-manager.js";
import { SpeechSessions } from "./speech/speech-sessions.js";
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
export function createSangamServer(env: ServerEnv = loadEnv()): SangamServer {
  const rooms = new RoomManager();
  const speechEnv = resolveSpeechEnv(env.speech);

  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: [...env.clientOrigins] }));
  app.get("/health", (_request, response) => {
    response.json({ ok: true, rooms: rooms.roomCount });
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
  const speech = new SpeechSessions(io, rooms, speechEnv);
  registerSocketHandlers(io, rooms, speech);

  const sweeper = setInterval(() => {
    rooms.sweepEmptyRooms();
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  return {
    env,
    httpServer,
    io,
    rooms,
    speech,
    speechEnv,
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
