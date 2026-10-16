"use client";

import { ArrowRight, Headphones, Mic } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { LanguageSelect } from "@/features/room/components/language-select";
import { useRoomLookup } from "@/features/room/hooks/use-room-lookup";
import type { LanguagePreferences } from "@/features/room/utils/language-preference";
import { languageLabel } from "@/features/translation/data/languages";
import type { LanguageCode } from "@/types";

export interface PreJoinLanguagesProps {
  readonly code: string;
  /** Prefill (English/English when the URL carried no parameters). */
  readonly initial: LanguagePreferences;
  readonly onJoin: (preferences: LanguagePreferences) => void;
}

/**
 * Pre-join language choice for bare `/room/CODE` URLs. Reuses the same
 * selectors and language definitions as the landing screen. Invite links
 * (which already carry both parameters) never render this — they join
 * directly with the mirrored pair. When the room server knows the creator's
 * stored pair, the mirrored values become the selectors' values unless
 * already edited by hand; a definitively unjoinable room (unknown, full)
 * reports its clear error here instead of joining silently.
 */
export function PreJoinLanguages({
  code,
  initial,
  onJoin,
}: PreJoinLanguagesProps) {
  const [speaking, setSpeaking] = useState<LanguageCode>(initial.speaking);
  const [listening, setListening] = useState<LanguageCode>(initial.listening);
  const editedRef = useRef(false);
  const { lookup, lookingUp, refresh } = useRoomLookup(code);

  useEffect(() => {
    if (lookup?.status === "ready" && !editedRef.current) {
      setSpeaking(lookup.guest.speaking);
      setListening(lookup.guest.listening);
    }
  }, [lookup]);

  const blockingError =
    lookup?.status === "failed" && lookup.blocking ? lookup.message : null;
  const lookupWarning =
    lookup?.status === "failed" && !lookup.blocking ? lookup.message : null;
  const mirroredNote =
    lookup?.status === "ready"
      ? `Room ${code}: you speak ${languageLabel(lookup.guest.speaking)} and hear ${languageLabel(lookup.guest.listening)} — mirrored from the creator.`
      : null;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-4 py-10">
      <section className="glass shadow-soft space-y-4 rounded-3xl p-4 sm:p-6">
        <div className="space-y-1 text-center">
          <p className="text-mute font-mono text-xs tracking-[0.3em]">{code}</p>
          <h1 className="font-display text-2xl font-bold tracking-tight">
            Choose your languages
          </h1>
          <p className="text-mute text-sm">
            {lookingUp
              ? "Looking up the room's languages…"
              : (mirroredNote ??
                "You joined with just the room code, so pick the languages for this device before entering. The invite link fills these in automatically.")}
          </p>
        </div>

        {blockingError ? (
          <div className="space-y-3 text-center">
            <p role="alert" className="text-danger text-sm">
              {blockingError}
            </p>
            <div className="flex justify-center gap-2">
              <Button size="sm" onClick={refresh}>
                Try again
              </Button>
              <Link
                href="/"
                className="text-mute inline-flex min-h-9 items-center text-sm underline"
              >
                Back home
              </Link>
            </div>
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <LanguageSelect
                id="prejoin-speaking"
                label="I speak"
                hint="The language you talk in."
                icon={Mic}
                value={speaking}
                onChange={(next) => {
                  editedRef.current = true;
                  setSpeaking(next);
                }}
              />
              <LanguageSelect
                id="prejoin-listening"
                label="I want to hear"
                hint="The language you want your partner's words in."
                icon={Headphones}
                value={listening}
                onChange={(next) => {
                  editedRef.current = true;
                  setListening(next);
                }}
              />
            </div>

            {lookupWarning ? (
              <p className="text-mute text-center text-xs">{lookupWarning}</p>
            ) : null}

            <Button
              size="lg"
              className="w-full"
              onClick={() => onJoin({ speaking, listening })}
            >
              Join room
              <ArrowRight aria-hidden="true" className="size-4" />
            </Button>
          </>
        )}
      </section>
    </div>
  );
}
