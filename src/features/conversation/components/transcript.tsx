import { MessagesSquare } from "lucide-react";
import { TranscriptEntryRow } from "@/features/conversation/components/transcript-entry";
import type {
  InterimUtterance,
  TranscriptEntry,
} from "@/features/conversation/types";
import type { SpeakerSide } from "@/features/room/types";
import { languageLabel } from "@/features/translation/data/languages";
import { cn } from "@/lib/utils";

export interface TranscriptProps {
  readonly entries: readonly TranscriptEntry[];
  readonly authorNames: Readonly<Record<"a" | "b", string>>;
  /** Live, replaceable interim lines; rendered after the finalized rows. */
  readonly interims?: Readonly<Partial<Record<SpeakerSide, InterimUtterance>>>;
  readonly className?: string;
}

/** One live interim line: visually distinct from finalized transcript rows. */
function InterimRow({
  interim,
  authorName,
}: {
  readonly interim: InterimUtterance;
  readonly authorName: string;
}) {
  const accent = interim.side === "a" ? "var(--speaker-a)" : "var(--speaker-b)";
  return (
    <li className="rise flex gap-3">
      <span
        aria-hidden="true"
        className="mt-1.5 size-2.5 shrink-0 rounded-full opacity-60"
        style={{ background: accent }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-mute text-sm font-semibold">{authorName}</span>
          <span className="text-mute flex items-center gap-1.5 text-xs">
            <span
              aria-hidden="true"
              className="blink size-1.5 rounded-full"
              style={{ background: accent }}
            />
            transcribing in {languageLabel(interim.language)}…
          </span>
        </div>
        <p className="text-mute mt-1 text-[15px] leading-relaxed italic">
          {interim.text}
          <span aria-hidden="true">…</span>
        </p>
      </div>
    </li>
  );
}

/** Scrollable conversation history: original text plus its translation. */
export function Transcript({
  entries,
  authorNames,
  interims,
  className,
}: TranscriptProps) {
  const interimSides = (["a", "b"] as const).filter(
    (side) => interims?.[side]?.text.trim().length,
  );

  return (
    <section
      aria-label="Conversation transcript"
      className={cn(
        "border-line bg-surface flex min-h-0 flex-col overflow-hidden rounded-3xl border",
        className,
      )}
    >
      <header className="border-line flex items-center gap-2 border-b px-4 py-3">
        <MessagesSquare aria-hidden="true" className="text-mute size-4" />
        <h2 className="font-display text-sm font-semibold tracking-tight">
          Transcript
        </h2>
        <span className="border-line text-mute ml-auto rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase">
          Untranslated
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        {entries.length === 0 && interimSides.length === 0 ? (
          <div className="flex h-full min-h-32 flex-col items-center justify-center gap-2 text-center">
            <MessagesSquare aria-hidden="true" className="text-mute size-6" />
            <p className="text-sm font-medium">Nothing said yet</p>
            <p className="text-mute max-w-xs text-xs">
              Use the microphone where your browser supports it, or type a
              message below. Translation arrives in a later stage.
            </p>
          </div>
        ) : (
          <ol className="space-y-5">
            {entries.map((entry) => (
              <TranscriptEntryRow
                key={entry.utterance.id}
                entry={entry}
                authorName={authorNames[entry.utterance.speakerSide]}
              />
            ))}
            {interimSides.map((side) => {
              const interim = interims?.[side];
              if (!interim) return null;
              return (
                <InterimRow
                  key={`interim-${side}`}
                  interim={interim}
                  authorName={authorNames[side]}
                />
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
