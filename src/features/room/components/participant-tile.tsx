import { Headphones, Mic, UserPlus, Volume2 } from "lucide-react";
import type { SpeakerState } from "@/features/conversation/types";
import { Waveform } from "@/features/conversation/components/waveform";
import type { ParticipantProfile, SpeakerSide } from "@/features/room/types";
import {
  participantAriaLabel,
  roleLabel,
  type TilePlayback,
} from "@/features/room/utils/identity";
import {
  languageLabel,
  languageNative,
} from "@/features/translation/data/languages";
import { cn } from "@/lib/utils";

export type { TilePlayback };

function badgeLabel(
  state: SpeakerState,
  participant: ParticipantProfile | null,
): string {
  if (!participant) return "Waiting for partner";
  if (state === "speaking") return "Speaking";
  if (state === "translating") return "Translating";
  if (state === "interrupted") return "Interrupted";
  if (state === "disconnected") return "Left the room";
  return "Listening";
}

export interface ParticipantTileProps {
  readonly side: SpeakerSide;
  readonly participant: ParticipantProfile | null;
  readonly state: SpeakerState;
  /** True when this card is this device's own seat (server-assigned). */
  readonly isSelf?: boolean;
  /** This seat's microphone is capturing right now. */
  readonly capturing?: boolean;
  /** Translated audio for this seat is playing on this device. */
  readonly playing?: boolean;
  /** Which side of the current playback this seat is, with its label. */
  readonly playback?: TilePlayback | null;
  readonly className?: string;
}

/**
 * One speaker seat. Identity, language direction, and audio role all come from
 * the server's session data: the card never guesses who it is. Role is shown
 * with text plus a distinct fill, so it never relies on colour alone, and the
 * state badge keeps its own border/label as before.
 */
export function ParticipantTile({
  side,
  participant,
  state,
  isSelf = false,
  capturing = false,
  playing = false,
  playback = null,
  className,
}: ParticipantTileProps) {
  const accent = side === "a" ? "var(--speaker-a)" : "var(--speaker-b)";
  const onAccent = side === "a" ? "var(--on-a)" : "var(--on-b)";
  const glow = side === "a" ? "var(--glow-a)" : "var(--glow-b)";
  const active = state === "speaking";
  const broken = state === "disconnected";
  const badge = badgeLabel(state, participant);
  const role = roleLabel(isSelf);

  const waveformVariant =
    state === "speaking"
      ? "active"
      : broken || state === "interrupted"
        ? "flat"
        : "idle";

  const ariaLabel = participant
    ? participantAriaLabel({
        isSelf,
        name: participant.displayName,
        speaks: participant.language,
        hears: participant.listeningLanguage,
        state: badge,
        playback: playback?.label ?? null,
      })
    : `${role}, empty seat, waiting for partner`;

  return (
    <article
      aria-label={ariaLabel}
      style={
        active
          ? { borderColor: accent, boxShadow: `0 0 0 6px ${glow}` }
          : undefined
      }
      className={cn(
        "relative flex flex-col gap-4 rounded-3xl border-2 p-5 transition-[box-shadow,border-color,transform] duration-300",
        isSelf
          ? "border-ink/25 bg-ink/[0.04] shadow-soft"
          : "border-line bg-surface",
        state === "interrupted" && "border-dashed",
        broken && "border-danger/50 border-dashed",
        !participant && "border-dashed bg-transparent shadow-none",
        className,
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-bold tracking-wider uppercase",
              isSelf
                ? "bg-ink text-bg"
                : "border-line text-mute border",
            )}
          >
            {role}
          </span>
          <p className="font-display truncate text-lg font-semibold">
            {participant ? participant.displayName : "Open seat"}
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

      {participant ? (
        <dl className="space-y-1.5 text-sm">
          <div className="flex items-baseline gap-2">
            <dt className="text-mute w-20 shrink-0 text-[10px] font-semibold tracking-wider uppercase">
              {isSelf ? "You speak" : "Speaks"}
            </dt>
            <dd className="min-w-0">
              <span className="font-medium">
                {languageLabel(participant.language)}
              </span>{" "}
              <span className="text-mute text-xs">
                {languageNative(participant.language)}
              </span>
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-mute w-20 shrink-0 text-[10px] font-semibold tracking-wider uppercase">
              {isSelf ? "You hear" : "Hears"}
            </dt>
            <dd className="min-w-0">
              <span className="font-medium">
                {languageLabel(participant.listeningLanguage)}
              </span>{" "}
              <span className="text-mute text-xs">
                {languageNative(participant.listeningLanguage)}
              </span>
            </dd>
          </div>
        </dl>
      ) : (
        <p className="text-mute text-sm">
          Share the room code to invite someone.
        </p>
      )}

      {playback ? (
        <p
          role="status"
          className={cn(
            "flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium",
            playback.role === "listener"
              ? "border-bridge/50 bg-bridge/10 text-ink"
              : "border-line text-mute",
          )}
        >
          {playback.role === "listener" ? (
            <Headphones aria-hidden="true" className="blink size-3.5 shrink-0" />
          ) : (
            <Volume2 aria-hidden="true" className="size-3.5 shrink-0" />
          )}
          <span className="min-w-0">{playback.label}</span>
        </p>
      ) : null}

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

      {capturing && participant ? (
        <p className="text-mute flex items-center gap-1.5 text-xs">
          <Mic aria-hidden="true" className="size-3.5" />
          Your microphone is on — your words are transcribed live.
        </p>
      ) : null}
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
