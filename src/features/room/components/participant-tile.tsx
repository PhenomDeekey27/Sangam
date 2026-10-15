import { Volume2, UserPlus } from "lucide-react";
import type { SpeakerState } from "@/features/conversation/types";
import { Waveform } from "@/features/conversation/components/waveform";
import type { ParticipantProfile, SpeakerSide } from "@/features/room/types";
import {
  languageLabel,
  languageNative,
} from "@/features/translation/data/languages";
import { cn } from "@/lib/utils";

function badgeLabel(
  state: SpeakerState,
  participant: ParticipantProfile | null,
  capturing: boolean,
): string {
  if (!participant) return "Waiting for partner";
  if (state === "speaking") return capturing ? "Listening…" : "Speaking";
  if (state === "translating") return "Translating";
  if (state === "interrupted") return "Interrupted";
  if (state === "disconnected") return "Left the room";
  return "Listening";
}

export interface ParticipantTileProps {
  readonly side: SpeakerSide;
  readonly participant: ParticipantProfile | null;
  readonly state: SpeakerState;
  readonly capturing?: boolean;
  /** This participant is receiving translated audio right now. */
  readonly playing?: boolean;
  readonly className?: string;
}

/**
 * One speaker seat. The current speaker is unmistakable through border,
 * halo, filled badge, waveform motion, and a "Speaking" label — never colour
 * alone. The empty seat renders its own waiting variant.
 */
export function ParticipantTile({
  side,
  participant,
  state,
  capturing = false,
  playing = false,
  className,
}: ParticipantTileProps) {
  const accent = side === "a" ? "var(--speaker-a)" : "var(--speaker-b)";
  const onAccent = side === "a" ? "var(--on-a)" : "var(--on-b)";
  const glow = side === "a" ? "var(--glow-a)" : "var(--glow-b)";
  const active = state === "speaking";
  const broken = state === "disconnected";
  const badge = badgeLabel(state, participant, capturing);

  const waveformVariant =
    state === "speaking"
      ? "active"
      : broken || state === "interrupted"
        ? "flat"
        : "idle";

  return (
    <article
      aria-label={
        participant
          ? `${participant.displayName}, ${languageLabel(participant.language)}, ${badge}`
          : "Empty seat, waiting for partner"
      }
      style={
        active
          ? { borderColor: accent, boxShadow: `0 0 0 6px ${glow}` }
          : undefined
      }
      className={cn(
        "bg-surface relative flex flex-col gap-4 rounded-3xl border p-5 transition-[box-shadow,border-color,transform] duration-300",
        active ? "border-2" : "border-line",
        state === "interrupted" && "border-dashed",
        broken && "border-danger/50 border-dashed",
        !participant && "border-dashed bg-transparent",
        className,
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display truncate text-base font-semibold">
            {participant ? participant.displayName : "Open seat"}
          </p>
          <p className="text-mute text-xs">
            {participant
              ? `${languageLabel(participant.language)} · ${languageNative(participant.language)}`
              : "Share the room code to invite someone"}
          </p>
        </div>

        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-wide",
            active ? "border-transparent" : "border-line text-mute",
            state === "interrupted" && "border-dashed",
            broken && "border-danger/50 text-danger",
          )}
          style={active ? { background: accent, color: onAccent } : undefined}
        >
          {playing ? (
            <Volume2 aria-hidden="true" className="blink size-3.5" />
          ) : null}
          {badge}
        </span>
      </header>

      <div className="flex items-center gap-4">
        <span className="relative inline-flex size-14 shrink-0 items-center justify-center">
          {active ? (
            <>
              <span
                aria-hidden="true"
                className="absolute inset-0 rounded-full border-2 ring"
                style={{ borderColor: accent }}
              />
              <span
                aria-hidden="true"
                className="absolute inset-0 rounded-full border-2 ring ring-2"
                style={{ borderColor: accent }}
              />
            </>
          ) : null}
          <span
            className={cn(
              "relative z-10 inline-flex size-14 items-center justify-center rounded-full",
              !participant && "border-line border border-dashed",
            )}
            style={
              participant
                ? { background: accent, color: onAccent }
                : { color: "var(--mute)" }
            }
          >
            {participant ? (
              <span className="font-display text-lg font-bold">
                {participant.displayName.charAt(0).toUpperCase()}
              </span>
            ) : (
              <UserPlus aria-hidden="true" className="size-6" />
            )}
          </span>
        </span>

        <Waveform
          variant={waveformVariant}
          side={side}
          className="min-w-0 flex-1"
        />
      </div>

      {broken && participant ? (
        <p className="text-danger text-xs">
          {participant.displayName} disconnected — the bridge is paused.
        </p>
      ) : null}
      {!participant ? (
        <p className="text-mute text-xs">
          Waiting for your partner to join with the room code.
        </p>
      ) : null}
    </article>
  );
}
