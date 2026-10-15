/**
 * Server-side room model. Membership lives purely in process memory for this
 * MVP: every room and all conversation state is lost when the server restarts,
 * and state does not replicate across multiple server instances.
 */
import type { WireError } from "../utils/errors.js";

/** Which of the two speaker seats a participant occupies. Server-assigned only. */
export type ParticipantSide = "a" | "b";

/** Lifecycle of a room as the server tracks it. */
export type RoomStatus = "waiting" | "live";

/** A participant as the server knows them (never built from client claims). */
export interface RoomParticipant {
  /** Server-generated opaque id (crypto.randomUUID). */
  readonly id: string;
  /** Socket connection this membership is bound to. */
  readonly socketId: string;
  readonly side: ParticipantSide;
  /** BCP-47-ish language tag the participant speaks (validated on join). */
  readonly language: string;
  /** Optional display name; server default when the client sends none. */
  readonly displayName: string;
  readonly joinedAt: number;
}

/** An in-memory room: at most one participant per side. */
export interface Room {
  readonly code: string;
  readonly createdAt: number;
  /** Set when the room becomes empty; used for the empty-room expiry sweep. */
  emptySince: number | null;
  readonly participants: Map<ParticipantSide, RoomParticipant>;
  /** Monotonic per-room counter stamped on each relayed utterance. */
  utteranceSeq: number;
  /** Client-generated utterance ids already relayed; rejects re-plays. */
  readonly usedUtteranceIds: Set<string>;
}

/** Where a socket is currently a member, if anywhere. */
export interface Membership {
  readonly code: string;
  readonly participantId: string;
  readonly side: ParticipantSide;
}

/** Public snapshot shape, aligned with the frontend's `room:state` payload. */
export interface RoomSnapshot {
  readonly code: string;
  readonly status: RoomStatus;
  readonly participants: readonly {
    readonly id: string;
    readonly side: ParticipantSide;
    readonly status: "connected";
    readonly displayName: string;
    readonly language: string;
  }[];
}

/** A room joined or created, or a structured refusal. */
export type JoinResult =
  | {
      readonly ok: true;
      readonly room: Room;
      readonly participant: RoomParticipant;
      /** A brand-new room was reserved by this call (create flow). */
      readonly created: boolean;
    }
  | { readonly ok: false; readonly error: WireError };

/** Membership that was just removed (leave or disconnect). */
export interface Departure {
  readonly code: string;
  readonly participant: RoomParticipant;
  /** Members still in the room after the departure. */
  readonly remaining: readonly RoomParticipant[];
  /** True when the room hit zero participants. */
  readonly roomEmpty: boolean;
}
