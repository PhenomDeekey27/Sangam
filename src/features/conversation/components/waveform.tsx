import type { SpeakerSide } from "@/features/room/types";
import { cn } from "@/lib/utils";

/** Bar heights (%) shape a natural, non-uniform waveform silhouette. */
const HEIGHTS = [44, 72, 100, 58, 86, 46, 96, 64, 80, 52, 68];

/** The three waveform behaviours from the design table. */
export type WaveformVariant = "active" | "idle" | "flat";

export interface WaveformProps {
  readonly variant: WaveformVariant;
  readonly side: SpeakerSide;
  readonly className?: string;
}

/**
 * CSS-only waveform. `active` runs the staggered `bar` keyframes, `idle`
 * breathes slowly, `flat` freezes collapsed. Purely decorative — the speaker
 * badge carries the meaning for assistive tech.
 */
export function Waveform({ variant, side, className }: WaveformProps) {
  const color = side === "a" ? "bg-speaker-a" : "bg-speaker-b";
  const animation =
    variant === "active"
      ? "bar"
      : variant === "idle"
        ? "breathe opacity-70"
        : "scale-y-[0.15] opacity-35";

  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex h-8 items-center justify-center gap-[3px]",
        className,
      )}
    >
      {HEIGHTS.map((height, index) => (
        <span
          key={index}
          style={{ height: `${height}%` }}
          className={cn("w-[3px] rounded-full", color, animation)}
        />
      ))}
    </div>
  );
}
