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
 * Which speech-to-text engine the server is currently able to run.
 * - `deepgram` — a real, credentialed streaming provider (server-side only).
 * - `mock`     — a deterministic development/test double; never real speech.
 * - `none`     — no server provider configured; clients fall back to the
 *                browser's own (limited) recognition or the text composer.
 * The API key never leaves the server: this is only a capability label.
 */
export type SpeechProviderId = "deepgram" | "mock" | "none";

/** What the server advertises about its speech pipeline on connect. */
export interface SpeechCapabilities {
  readonly provider: SpeechProviderId;
  /** True when the provider can consume a live audio stream. */
  readonly streaming: boolean;
  /** True when the provider emits replaceable interim transcripts. */
  readonly interim: boolean;
  /** Languages the provider accepts (BCP-47 primary subtags). */
  readonly languages: readonly LanguageCode[];
}

/**
 * Reply to `speech:start`. Success echoes the language the provider was
 * actually opened with, so a client can confirm its selection was honoured.
 */
export type SpeechStartAck =
  | { readonly ok: true; readonly language: LanguageCode }
  | { readonly ok: false; readonly error: SocketError };

/**
 * Client-generated correlation id for one interruption request. The server
 * echoes it on the ack and on the partner's confirmation, so a late reply
 * from an earlier attempt can never settle a newer one.
 */
export interface InterruptRequest {
  readonly interruptId: string;
}

/**
 * Reply to `conversation:interrupt`. `relayed` reports whether the request
 * actually reached a partner; it does **not** mean the partner has cancelled
 * their playback yet — that arrives later as `conversation:interrupt_confirmed`.
 */
export type InterruptAck =
  | {
      readonly ok: true;
      readonly interruptId: string;
      readonly relayed: boolean;
    }
  | { readonly ok: false; readonly error: SocketError };

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
 *
 * Language preferences: `language` is what the participant speaks (their own
 * recognition locale) and `listeningLanguage` is what they want to hear. Both
 * are validated server-side against the supported list and stored per
 * participant, so the two seats never overwrite each other. `listeningLanguage`
 * is optional on the wire; omitting it lets the room apply its default.
 */
export interface ClientToServerEvents {
  "room:create": (
    payload: {
      readonly code: RoomCode;
      readonly language: LanguageCode;
      readonly listeningLanguage?: LanguageCode;
    },
    ack?: (response: RoomOpAck) => void,
  ) => void;
  "room:join": (
    payload: {
      readonly code: RoomCode;
      readonly language: LanguageCode;
      readonly listeningLanguage?: LanguageCode;
    },
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
  "conversation:interrupt": (
    payload: InterruptRequest,
    ack?: (response: InterruptAck) => void,
  ) => void;
  /**
   * Sent by the interrupted partner once its own playback actually stopped and
   * the stale turn was discarded. The server routes it to the requester as
   * `conversation:interrupt_confirmed`; the requester's UI must not claim the
   * cancellation until this arrives.
   */
  "conversation:interrupt_ack": (payload: {
    readonly interruptId: string;
  }) => void;
  /**
   * Open a server-side recognition session for this socket's seat. The server
   * ignores any language that does not match the seat's stored speaking
   * language, and refuses sockets that are not seated room members.
   */
  "speech:start": (
    payload: {
      readonly language: LanguageCode;
      /** Metadata for the captured stream; validated server-side. */
      readonly mimeType?: string;
    },
    ack?: (response: SpeechStartAck) => void,
  ) => void;
  /**
   * One captured audio chunk. Binary so the codec payload is passed through
   * untouched; the server enforces per-session byte ceilings.
   */
  "speech:audio": (chunk: ArrayBuffer) => void;
  /** Close the recognition session gracefully (a final may still flush). */
  "speech:stop": () => void;
}

/**
 * Stage-6 translated-speech playback for one completed translation. Emitted
 * only to the listener's socket, at most once per utterance id per room.
 * `audio` is the binary second argument — a complete, self-describing audio
 * container (WAV) the browser can play directly. History replays never carry
 * audio: a rejoining seat gets the translated *text* rows only, and the
 * client queues delivery in the utterance `sequence` order.
 */
export interface PlaybackPayload {
  readonly utteranceId: UtteranceId;
  /** Per-room ordering stamp of the utterance being played. */
  readonly sequence: number;
  /** Language the audio was synthesized in (the listener's target). */
  readonly language: LanguageCode;
  readonly mimeType: string;
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
   * Retained transcript rows for the room this socket just joined, oldest
   * first. Sent only to the joiner, only for their own room, and before the
   * join ack, so a client can merge history ahead of live messages. Interims
   * are never included.
   */
  "conversation:history": (payload: {
    readonly code: RoomCode;
    readonly entries: readonly TranscriptEntry[];
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
  /**
   * Emitted to the partner of whoever interrupted; `side` is the interrupter.
   *
   * `sequence` is the room's last relayed utterance sequence at the moment the
   * interruption was accepted (server-stamped, not client-supplied). It is the
   * playback boundary: any translated audio stamped at or below it belongs to
   * the interrupted turn and must be stopped or dropped, while audio stamped
   * above it is new speech and plays normally. It is `0` before any utterance
   * has been relayed, which makes the interruption a pure stop with nothing to
   * discard.
   */
  "conversation:interrupt": (payload: {
    readonly side: SpeakerSide;
    readonly sequence: number;
    /** Echoes the requester's correlation id for the confirmation round trip. */
    readonly interruptId: string;
  }) => void;
  /**
   * Sent to the requester when the interrupted partner confirmed that its
   * playback stopped. `side` is the confirming (interrupted) participant, so
   * the requester can name whoever actually cancelled.
   */
  "conversation:interrupt_confirmed": (payload: {
    readonly side: SpeakerSide;
    readonly interruptId: string;
  }) => void;
  /**
   * Playable audio for one completed translation, delivered only to the
   * listener. Not part of `conversation:history`.
   */
  "conversation:playback": (payload: PlaybackPayload, audio: ArrayBuffer) => void;
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
  /**
   * Server speech pipeline availability, sent once per connection. Clients use
   * it to choose the server pipeline over browser-native recognition; the
   * provider's credentials are never part of this payload.
   */
  "speech:capabilities": (payload: SpeechCapabilities) => void;
  /**
   * Replaceable interim transcript for the socket's own speech, sent only to
   * the speaker (the partner receives the same line as `conversation:interim`).
   * An empty `text` clears the line after a final.
   */
  "speech:interim": (payload: {
    readonly text: string;
    readonly language: LanguageCode;
  }) => void;
  /** A fatal provider/heartbeat failure for the speaker's session. */
  "speech:error": (payload: SocketError) => void;
  error: (payload: SocketError) => void;
}
