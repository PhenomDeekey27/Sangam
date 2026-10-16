import type {
  InterimUtterance,
  SpeakerState,
  TranscriptEntry,
} from "@/features/conversation/types";
import type {
  ConnectionStatus,
  RoomMode,
  SpeakerSide,
} from "@/features/room/types";
import type { SeatAssignment } from "@/features/room/utils/derive";
import type { LanguageCode } from "@/types";
import type { SocketError } from "@/types/socket";

/** Identity the server assigned to this connection's membership. */
export interface SelfIdentity {
  readonly id: string;
  readonly side: SpeakerSide;
}

export interface UseRoomSocketOptions {
  readonly code: string;
  readonly mode: RoomMode;
  /** This participant's spoken language, stamped on every utterance. */
  readonly language: LanguageCode;
  /** This participant's "I want to hear" preference, stored on their seat. */
  readonly listeningLanguage: LanguageCode;
  /** Report status messages to the shared `aria-live` region. */
  readonly notify: (message: string | null) => void;
  /** The connection dropped or membership failed: stop live capture. */
  readonly onSilence: () => void;
}

/** Socket lifecycle, membership, transcript relay, and interim lines. */
export interface RoomSocketApi {
  readonly connection: ConnectionStatus;
  /** Fatal membership failure (unknown room, full room) for the error banner. */
  readonly roomError: SocketError | null;
  readonly seats: SeatAssignment;
  readonly entries: readonly TranscriptEntry[];
  /** Replaceable interim line the partner is speaking right now. */
  readonly partnerInterim: InterimUtterance | null;
  readonly youState: SpeakerState;
  readonly partnerState: SpeakerState;
  readonly retryConnection: () => void;
  /** Relay a finalized utterance under a fresh client-generated id. */
  readonly sendUtterance: (text: string, source: "typed" | "speech") => void;
  /** Send the current interim line; empty text clears the partner's view. */
  readonly emitInterim: (text: string) => void;
  readonly interrupt: () => void;
}
