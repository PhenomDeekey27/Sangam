/**
 * The wire contract is owned by the frontend (`src/types/socket.ts`) so both
 * sides share one vocabulary. This module re-exports it for the server with
 * type-only, relative imports — no runtime dependency on frontend code.
 */
export type {
  ClientToServerEvents,
  RoomOpAck,
  ServerToClientEvents,
  SocketError,
} from "../../../src/types/socket.js";
