import type { SpeakerSide } from "@/features/room/types";
import type { TranslationState } from "@/features/translation/types";
import type { LanguageCode } from "@/types";

/**
 * Turn-taking state of one speaker. Drives tile border, badge text,
 * waveform, and bridge animation.
 */
export type SpeakerState =
  | "idle"
  | "listening"
  | "speaking"
  | "translating"
  | "interrupted"
  | "disconnected";

/** Identifier for a single recognized utterance. */
export type UtteranceId = string;

/** A finalized chunk of original speech, before translation. */
export interface Utterance {
  readonly id: UtteranceId;
  readonly speakerSide: SpeakerSide;
  readonly language: LanguageCode;
  readonly text: string;
  /** Epoch milliseconds at which recognition finalized the utterance. */
  readonly finalizedAt: number;
  /** Per-room, server-assigned ordering counter (1-based, monotonic). */
  readonly sequence: number;
}

/**
 * A replaceable, not-yet-final recognition line for one speaker. Interims
 * are keyed by side: each new interim for a side replaces the previous one,
 * and an empty text (or a final utterance) clears it.
 */
export interface InterimUtterance {
  readonly side: SpeakerSide;
  readonly language: LanguageCode;
  readonly text: string;
}

/** One transcript row: an utterance plus the state of its translation. */
export interface TranscriptEntry {
  readonly utterance: Utterance;
  readonly translation: TranslationState;
}

/**
 * Conversation domain events, discriminated by `type`. Shared by the client
 * store and the real-time server so both sides agree on one vocabulary.
 */
export type ConversationEvent =
  | {
      readonly type: "speaker_state";
      readonly side: SpeakerSide;
      readonly state: SpeakerState;
    }
  | { readonly type: "utterance_finalized"; readonly entry: TranscriptEntry }
  | {
      readonly type: "translation_updated";
      readonly utteranceId: UtteranceId;
      readonly translation: TranslationState;
    }
  | { readonly type: "transcript_cleared" };
