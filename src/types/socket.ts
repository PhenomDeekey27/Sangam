import type {
  SpeakerState,
  TranscriptEntry,
  UtteranceId,
} from "@/features/conversation/types";
import type {
  ParticipantId,
  ParticipantProfile,
  RoomCode,
  RoomStatus,
  SpeakerSide,
} from "@/features/room/types";
import type { TranslationState } from "@/features/translation/types";
import type { LanguageCode } from "@/types";

/** Uniform error shape for socket-level failures. */
export interface SocketError {
  readonly code: string;
  readonly message: string;
}

/**
 * Reply to a `room:create` / `room:join` acknowledgement. Membership problems
 * (unknown room, full room, malformed code) arrive here rather than as a
 * fire-and-forget `error` event, so the caller always learns the outcome.
 * On success the server hands back the identity it assigned — clients must
 * treat `self` as the only authority for their id and side.
 */
export type RoomOpAck =
  | {
      readonly ok: true;
      readonly self: {
        readonly id: ParticipantId;
        readonly side: SpeakerSide;
      };
    }
  | { readonly ok: false; readonly error: SocketError };

/**
 * Wire contract between the browser and the Socket.IO server in `server/`.
 *
 * The server type-checks its handlers against this same module (via a
 * type-only import), so one file is the contract for both sides.
 *
 * Event-name mapping against the Stage-3 spec vocabulary:
 * - spec `participant:joined`      → `room:participant_joined` (kept)
 * - spec `participant:left`        → `room:participant_left` (kept)
 * - spec `room:error`              → `error` (kept; same SocketError payload)
 *
 * Identity rules on the wire: the server assigns `id` and `side` for every
 * participant and never accepts either from a client. `conversation:utterance`
 * client→server carries a client-generated `utteranceId` plus text and
 * language; the server stamps the entry with the sender's room side and a
 * per-room `sequence` for ordering. `conversation:interim` carries
 * replaceable partial recognition text (empty text clears the line) and is
 * relayed with the sender's server-side side.
 */
export interface ClientToServerEvents {
  "room:create": (
    payload: { readonly code: RoomCode; readonly language: LanguageCode },
    ack?: (response: RoomOpAck) => void,
  ) => void;
  "room:join": (
    payload: { readonly code: RoomCode; readonly language: LanguageCode },
    ack?: (response: RoomOpAck) => void,
  ) => void;
  "room:leave": (payload: { readonly code: RoomCode }) => void;
  "conversation:utterance": (payload: {
    /** Client-generated stable id; the server rejects repeats per room. */
    readonly utteranceId: UtteranceId;
    readonly text: string;
    readonly language: LanguageCode;
  }) => void;
  /**
   * Throttled partial recognition text. Empty `text` clears the sender's
   * interim line (utterance finalized or capture stopped).
   */
  "conversation:interim": (payload: {
    readonly text: string;
    readonly language: LanguageCode;
  }) => void;
  "conversation:interrupt": () => void;
}

export interface ServerToClientEvents {
  "room:state": (payload: {
    readonly code: RoomCode;
    readonly status: RoomStatus;
    readonly participants: readonly ParticipantProfile[];
  }) => void;
  "room:participant_joined": (payload: {
    readonly participant: ParticipantProfile;
  }) => void;
  "room:participant_left": (payload: {
    readonly participantId: ParticipantId;
  }) => void;
  "conversation:utterance": (payload: {
    readonly entry: TranscriptEntry;
  }) => void;
  /**
   * Replaceable interim transcript line from the room's other member.
   * Empty `text` means the sender's interim line should clear.
   */
  "conversation:interim": (payload: {
    readonly side: SpeakerSide;
    readonly text: string;
    readonly language: LanguageCode;
  }) => void;
  /** Emitted to the partner of whoever interrupted; `side` is the interrupter. */
  "conversation:interrupt": (payload: { readonly side: SpeakerSide }) => void;
  /** Reserved for the translation stage; not emitted by the Stage-3 server. */
  "conversation:translation": (payload: {
    readonly utteranceId: UtteranceId;
    readonly translation: TranslationState;
  }) => void;
  /** Reserved for the speech stage; not emitted by the Stage-3 server. */
  "conversation:speaker_state": (payload: {
    readonly side: SpeakerSide;
    readonly state: SpeakerState;
  }) => void;
  error: (payload: SocketError) => void;
}
