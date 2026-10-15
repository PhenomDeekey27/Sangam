"use client";

import type { SpeakerState } from "@/features/conversation/types";
import { ParticipantTile } from "@/features/room/components/participant-tile";
import { VoiceBridge } from "@/features/room/components/voice-bridge";
import { seatFor } from "@/features/room/utils/derive";
import type { SeatAssignment } from "@/features/room/utils/derive";
import { useMediaQuery } from "@/hooks/use-media-query";

export interface RoomStageProps {
  readonly seats: SeatAssignment;
  readonly speakerStates: Readonly<Record<"a" | "b", SpeakerState>>;
  readonly capturing: boolean;
  readonly playing: boolean;
  readonly flow: "none" | "a-to-b" | "b-to-a";
  readonly bridgeLabel: string | null;
  readonly broken: boolean;
}

/**
 * The two server-assigned seats around the Voice Bridge: side `a` on the left
 * (top on mobile), side `b` on the right. Whichever person the server seated
 * on each side renders there, so both clients agree on who is who.
 */
export function RoomStage({
  seats,
  speakerStates,
  capturing,
  playing,
  flow,
  bridgeLabel,
  broken,
}: RoomStageProps) {
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const left = seatFor(seats, "a");
  const right = seatFor(seats, "b");
  const youSide = seats.you?.side ?? "a";

  return (
    <section
      aria-label="Conversation stage"
      className="flex flex-col items-center gap-3 lg:grid lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-center lg:gap-4"
    >
      <ParticipantTile
        side="a"
        participant={left}
        state={speakerStates.a}
        capturing={capturing && youSide === "a"}
        className="w-full"
      />

      <VoiceBridge
        flow={flow}
        broken={broken}
        label={bridgeLabel ?? undefined}
        orientation={isDesktop ? "horizontal" : "vertical"}
        className="lg:px-2"
      />

      <ParticipantTile
        side="b"
        participant={right}
        state={speakerStates.b}
        playing={playing && youSide !== "b"}
        className="w-full"
      />
    </section>
  );
}
