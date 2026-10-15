import type { Server, Socket } from "socket.io";
import type { RoomManager } from "../rooms/room-manager.js";
import type { ClientToServerEvents, ServerToClientEvents } from "./contract.js";
import { handleDisconnect, registerRoomHandlers } from "./room-handlers.js";

type AppServer = Server<ClientToServerEvents, ServerToClientEvents>;
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

/**
 * Wire one Socket.IO server to a room manager. Called once per server
 * instance; per-connection listeners are registered on `connection` and
 * membership is released on `disconnect`.
 */
export function registerSocketHandlers(
  io: AppServer,
  rooms: RoomManager,
): void {
  io.on("connection", (socket: AppSocket) => {
    registerRoomHandlers(io, socket, rooms);
    socket.on("disconnect", () => {
      handleDisconnect(io, socket, rooms);
    });
  });
}
