import { io, type Socket } from "socket.io-client";
import { env } from "@/config/env";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@/types/socket";

/** Typed Socket.IO client bound to the shared wire contract. */
export type RoomSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: RoomSocket | null = null;

/**
 * Lazily create the app-wide room socket. It starts disconnected: the room
 * screen calls `connect()` once it actually needs a connection, and
 * `destroyRoomSocket()` tears everything down on unmount so no listener can
 * outlive the screen that registered it.
 */
export function getRoomSocket(): RoomSocket {
  socket ??= io(env.socketUrl, {
    autoConnect: false,
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 800,
    transports: ["websocket", "polling"],
  });
  return socket;
}

/** Disconnect and forget the singleton; the next `getRoomSocket()` is fresh. */
export function destroyRoomSocket(): void {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
}
