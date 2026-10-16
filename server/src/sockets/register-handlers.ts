import type { Server, Socket } from "socket.io";
import type { RoomManager } from "../rooms/room-manager.js";
import type { ClientToServerEvents, ServerToClientEvents } from "./contract.js";
import type { SpeechSessions } from "../speech/speech-sessions.js";
import { handleDisconnect, registerRoomHandlers } from "./room-handlers.js";

type AppServer = Server<ClientToServerEvents, ServerToClientEvents>;
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

/**
 * Wire one Socket.IO server to a room manager and its speech pipeline. Called
 * once per server instance; per-connection listeners are registered on
 * `connection`, and both membership and any live speech session are released
 * on `disconnect` and on `room:leave`.
 */
export function registerSocketHandlers(
  io: AppServer,
  rooms: RoomManager,
  speech: SpeechSessions,
): void {
  io.on("connection", (socket: AppSocket) => {
    registerRoomHandlers(io, socket, rooms);
    registerSpeechHandlers(socket, speech);

    socket.on("room:leave", () => {
      // Whether or not the leave payload validates, a departing member must
      // not keep an authorised recording session open.
      speech.release(socket.id);
    });
    socket.on("disconnect", () => {
      speech.release(socket.id);
      handleDisconnect(io, socket, rooms);
    });
  });
}

/** Per-connection speech pipeline: capabilities, audio, and teardown. */
function registerSpeechHandlers(
  socket: AppSocket,
  speech: SpeechSessions,
): void {
  socket.emit("speech:capabilities", speech.capabilities());

  socket.on("speech:start", (payload, ack) => {
    const result = speech.start(socket, {
      language: payload?.language,
      mimeType: payload?.mimeType,
    });
    ack?.(
      result.ok
        ? { ok: true, language: result.language }
        : { ok: false, error: result.error },
    );
  });

  socket.on("speech:audio", (chunk) => {
    speech.push(socket, chunk);
  });

  socket.on("speech:stop", () => {
    speech.stop(socket);
  });
}
