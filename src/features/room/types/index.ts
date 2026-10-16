import type { LanguageCode } from "@/types";

/** Opaque identifier for a participant within a room. */
export type ParticipantId = string;

/** Human-readable room identifier used in `/room/[code]` URLs. */
export type RoomCode = string;

/**
 * Which of the two speaker seats a participant occupies.
 * Matches the `speaker-a` / `speaker-b` design tokens.
 */
export type SpeakerSide = "a" | "b";

/** Lifecycle of a room from the perspective of its members. */
export type RoomStatus = "waiting" | "live" | "closed";

/** Connection state of a participant as reported by the real-time server. */
export type ParticipantStatus = "connecting" | "connected" | "disconnected";

/**
 * Connection of this client to the real-time room server.
 * Distinct from `RoomStatus`, which describes the room itself.
 *
 * Transport and membership are separate: `connected` is reported only after
 * the server confirms room membership (join/create acknowledgement) and
 * returns the room snapshot naming this participant's seat. `reconnecting`
 * means the transport dropped and the client is trying to rejoin;
 * `expired` means a previously joined room is gone server-side (backend
 * restart or expiry) and will not come back by retrying the same code.
 */
export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "expired"
  | "failed"
  | "disconnected";

/**
 * Why the room screen is opening: a creator reserves the code through
 * `room:create` (seated as side `a`), while an invited guest joins an
 * existing room through `room:join`.
 */
export type RoomMode = "create" | "join";

/** A member of a two-person room. */
export interface Participant {
  readonly id: ParticipantId;
  readonly side: SpeakerSide;
  readonly status: ParticipantStatus;
}

/**
 * A participant plus the presentation details a tile needs.
 * Extends the wire-level {@link Participant} rather than duplicating it.
 */
export interface ParticipantProfile extends Participant {
  readonly displayName: string;
  /** Language this participant speaks into the conversation. */
  readonly language: LanguageCode;
  /** Language this participant wants to hear; stored per participant. */
  readonly listeningLanguage: LanguageCode;
}

/** Membership snapshot of a room. */
export interface Room {
  readonly code: RoomCode;
  readonly status: RoomStatus;
  readonly participants: readonly Participant[];
}
