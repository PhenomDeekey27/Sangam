/**
 * Presentation helpers for participant identity. Every value here is derived
 * from the server-assigned seat (`id`, `side`) and the stored per-seat
 * languages — nothing is inferred from socket order, device type, or the
 * selected language. Keeping the labels pure and shared means the tile, the
 * stage, and their tests agree on one wording.
 */
import { languageLabel } from "@/features/translation/data/languages";
import type { SpeakerSide } from "@/features/room/types";
import type { LanguageCode } from "@/types";

/** Role label for a participant card; "You" is always this device's seat. */
export type ParticipantRole = "You" | "Other participant";

export function roleLabel(isSelf: boolean): ParticipantRole {
  return isSelf ? "You" : "Other participant";
}

/** "Tamil → English": the language direction stored for one participant. */
export function languageDirection(
  speaks: LanguageCode,
  hears: LanguageCode,
): string {
  return `${languageLabel(speaks)} → ${languageLabel(hears)}`;
}

/** One-sentence direction, phrased from the local participant's viewpoint. */
export function directionSentence(
  isSelf: boolean,
  speaks: LanguageCode,
  hears: LanguageCode,
): string {
  const subject = isSelf ? "You" : "They";
  return `${subject} speak ${languageLabel(speaks)} and hear ${languageLabel(hears)}.`;
}

/** Role of a participant in the translated audio playing right now. */
export interface TilePlayback {
  /** `source` speaks the audio; `listener` hears it. */
  readonly role: "source" | "listener";
  readonly label: string;
}

/** The translated-audio turn in progress: whose speech, in which language. */
export interface ActivePlayback {
  /** The seat whose speech is being played (never the listener). */
  readonly speakerSide: SpeakerSide;
  /** The audio's language — the listener's target. */
  readonly language: LanguageCode;
}

/**
 * Which side of the active playback one seat is, with its label, or `null`
 * when that seat is not part of it. The audio is heard by the listener, so the
 * source card never claims to be the one hearing it.
 */
export function playbackForSide(
  side: SpeakerSide,
  active: ActivePlayback | null,
  youSide: SpeakerSide,
  partnerName: string | null,
): TilePlayback | null {
  if (!active) return null;
  const labels = playbackRoleLabels(
    active.speakerSide,
    active.language,
    youSide,
    partnerName,
  );
  if (side === active.speakerSide) {
    return { role: "source", label: labels.source };
  }
  if (side === otherSide(active.speakerSide)) {
    return { role: "listener", label: labels.listener };
  }
  return null;
}

/** Screen-reader label for one participant card. */
export function participantAriaLabel(input: {
  readonly isSelf: boolean;
  readonly name: string;
  readonly speaks: LanguageCode;
  readonly hears: LanguageCode;
  readonly state: string;
  /** Optional description of the current translated-audio role. */
  readonly playback?: string | null;
}): string {
  const parts = [
    roleLabel(input.isSelf),
    input.name,
    `speaks ${languageLabel(input.speaks)}`,
    `hears ${languageLabel(input.hears)}`,
    input.state,
  ];
  if (input.playback) parts.push(input.playback);
  return parts.join(", ");
}

/** The other seat in a two-person room. */
export function otherSide(side: SpeakerSide): SpeakerSide {
  return side === "a" ? "b" : "a";
}

export interface PlaybackRoleLabels {
  /** Label for the participant whose translated speech is playing. */
  readonly source: string;
  /** Label for the participant who is hearing it. */
  readonly listener: string;
}

/**
 * One active translated-audio item, split into who is speaking (the source)
 * and who hears it (the listener). The audio always plays on the listener's
 * device, so the source is never labelled as the person hearing it.
 */
export function playbackRoleLabels(
  speakerSide: SpeakerSide,
  language: LanguageCode,
  youSide: SpeakerSide,
  partnerName: string | null,
): PlaybackRoleLabels {
  const lang = languageLabel(language);
  const nameFor = (side: SpeakerSide) =>
    side === youSide ? "you" : (partnerName ?? "your partner");
  return {
    source: `Playing to ${nameFor(otherSide(speakerSide))} in ${lang}`,
    listener: `Hearing ${nameFor(speakerSide)} in ${lang}`,
  };
}
