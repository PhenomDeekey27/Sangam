/**
 * Server-side room model. Membership lives purely in process memory for this
 * MVP: every room and all conversation state is lost when the server restarts,
 * and state does not replicate across multiple server instances.
 */
import type { WireError } from "../utils/errors.js";
import type { TranslationState } from "../../../src/features/translation/types/index.js";

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
  /**
   * Language this participant speaks into the conversation. Drives their own
   * speech recognition; validated against the supported list on join.
   */
  readonly language: string;
  /**
   * Language this participant wants to *hear* (the translation target in a
   * later stage). Stored per participant — never shared between the two
   * seats, so one person's preference cannot overwrite the other's.
   */
  readonly listeningLanguage: string;
  /** Optional display name; server default when the client sends none. */
  readonly displayName: string;
  readonly joinedAt: number;
}

/** One finalized utterance as retained in room history (never an interim). */
export interface RoomUtterance {
  readonly id: string;
  readonly speakerSide: ParticipantSide;
  readonly language: string;
  readonly text: string;
  readonly finalizedAt: number;
  readonly sequence: number;
}

/** A retained transcript row: the original utterance plus translation state. */
export interface RoomTranscriptEntry {
  readonly utterance: RoomUtterance;
  /**
   * Starts `unavailable`; the translation service mutates this field in place
   * to `complete`/`failed` so history replays carry the latest translation.
   */
  translation: TranslationState;
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
  /**
   * Finalized transcript entries for this room's lifetime, oldest first.
   * Interims are deliberately never stored. Lives only as long as the room:
   * it is dropped with the room on expiry and lost on server restart.
   */
  readonly transcript: RoomTranscriptEntry[];
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
    readonly listeningLanguage: string;
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
