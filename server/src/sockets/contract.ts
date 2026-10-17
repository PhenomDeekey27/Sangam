/**
 * The wire contract is owned by the frontend (`src/types/socket.ts`) so both
 * sides share one vocabulary. This module re-exports it for the server with
 * type-only, relative imports — no runtime dependency on frontend code.
 */
export type {
  ClientToServerEvents,
  InterruptAck,
  InterruptRequest,
  PlaybackPayload,
  PlaybackUnavailablePayload,
  PlaybackUnavailableReason,
  RoomOpAck,
  ServerToClientEvents,
  SocketError,
  SpeechCapabilities,
  SpeechProviderId,
  SpeechStartAck,
} from "../../../src/types/socket.js";
