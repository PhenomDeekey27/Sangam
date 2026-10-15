import { Loader2, TriangleAlert } from "lucide-react";
import type { TranscriptEntry } from "@/features/conversation/types";
import type { SpeakerSide } from "@/features/room/types";
import type { TranslationState } from "@/features/translation/types";
import { languageLabel } from "@/features/translation/data/languages";
import { formatClockTime } from "@/lib/format";
import { cn } from "@/lib/utils";

function TranslationBody({
  translation,
}: {
  readonly translation: TranslationState;
}) {
  if (translation.status === "unavailable") {
    return (
      <p className="text-mute text-sm">
        Translation is not applied yet — the original text is shown as-is.
      </p>
    );
  }

  if (translation.status === "failed") {
    return (
      <p className="text-danger flex items-start gap-2 text-sm">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {translation.error.message}
      </p>
    );
  }

  if (translation.status === "complete") {
    return <p className="text-sm">{translation.text}</p>;
  }

  return (
    <p className="text-mute flex items-center gap-2 text-sm">
      <Loader2 aria-hidden="true" className="blink size-4" />
      {translation.status === "queued"
        ? "Waiting to translate…"
        : "Translating…"}
    </p>
  );
}

export interface TranscriptEntryRowProps {
  readonly entry: TranscriptEntry;
  readonly authorName: string;
}

/** One utterance with its original text and translation, clearly labelled. */
export function TranscriptEntryRow({
  entry,
  authorName,
}: TranscriptEntryRowProps) {
  const { utterance, translation } = entry;
  const side: SpeakerSide = utterance.speakerSide;
  const accent = side === "a" ? "var(--speaker-a)" : "var(--speaker-b)";
  const targetLabel =
    translation.status === "complete"
      ? `Translated to ${languageLabel(translation.targetLanguage)}`
      : translation.status === "failed"
        ? "Translation failed"
        : translation.status === "unavailable"
          ? "Untranslated"
          : "Translation pending";

  return (
    <li className="rise flex gap-3">
      <span
        aria-hidden="true"
        className="mt-1.5 size-2.5 shrink-0 rounded-full"
        style={{ background: accent }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-sm font-semibold">{authorName}</span>
          <span className="text-mute text-xs">
            said in {languageLabel(utterance.language)}
          </span>
          <time
            suppressHydrationWarning
            dateTime={new Date(utterance.finalizedAt).toISOString()}
            className="text-mute ml-auto text-[11px] tabular-nums"
          >
            {formatClockTime(utterance.finalizedAt)}
          </time>
        </div>

        <p className="mt-1 text-[15px] leading-relaxed">{utterance.text}</p>

        <div
          className={cn(
            "border-line/70 bg-ink/[0.04] dark:bg-ink/[0.08] mt-2 rounded-xl border px-3 py-2",
            translation.status === "failed" && "border-danger/40",
          )}
        >
          <p className="text-mute text-[10px] font-semibold tracking-wider uppercase">
            {targetLabel}
          </p>
          <div className="mt-1">
            <TranslationBody translation={translation} />
          </div>
        </div>
      </div>
    </li>
  );
}
