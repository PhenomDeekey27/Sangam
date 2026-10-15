import type { SpeakerState } from "@/features/conversation/types";
import type {
  ConnectionStatus,
  ParticipantProfile,
  SpeakerSide,
} from "@/features/room/types";

/**
 * The two seats ordered by server-assigned side. `you` occupies their own
 * side; the partner takes the other seat when present.
 */
export interface SeatAssignment {
  readonly you: ParticipantProfile | null;
  readonly partner: ParticipantProfile | null;
}

/** Seat of a given side, or `null` when that seat is empty. */
export function seatFor(
  seats: SeatAssignment,
  side: SpeakerSide,
): ParticipantProfile | null {
  const youSide = seats.you?.side ?? "a";
  return side === youSide ? seats.you : seats.partner;
}

/** Per-side speaker states; an absent partner reads as `disconnected`. */
export function toSpeakerStates(
  youSide: SpeakerSide,
  youState: SpeakerState,
  partnerState: SpeakerState,
  partnerPresent: boolean,
): Record<SpeakerSide, SpeakerState> {
  return youSide === "a"
    ? { a: youState, b: partnerPresent ? partnerState : "disconnected" }
    : { a: partnerPresent ? partnerState : "disconnected", b: youState };
}

/** Whoever currently holds the turn, or `null` when the room is quiet. */
export function toActiveSpeaker(
  seats: SeatAssignment,
  youState: SpeakerState,
  partnerState: SpeakerState,
): SpeakerSide | null {
  if (seats.you && (youState === "speaking" || youState === "translating")) {
    return seats.you.side;
  }
  if (seats.partner && partnerState === "speaking") {
    return seats.partner.side;
  }
  return null;
}

/** Flow direction along the Voice Bridge for the active speaker. */
export function toFlow(
  active: SpeakerSide | null,
): "none" | "a-to-b" | "b-to-a" {
  if (active === "a") return "a-to-b";
  if (active === "b") return "b-to-a";
  return "none";
}

/** The arch is severed whenever a partner or a healthy connection is missing. */
export function toBroken(
  partnerPresent: boolean,
  connection: ConnectionStatus,
): boolean {
  return !partnerPresent || connection !== "connected";
}
