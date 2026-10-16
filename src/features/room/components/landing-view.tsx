"use client";

import {
  Headphones,
  KeyRound,
  Mic,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Wordmark } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { PREVIEW_STAGE_NOTE } from "@/lib/constants";
import { JoinCodeForm } from "@/features/room/components/join-code-form";
import { LanguageSelect } from "@/features/room/components/language-select";
import { VoiceBridge } from "@/features/room/components/voice-bridge";
import { createRoomCode } from "@/features/room/utils/room-code";
import { roomPath } from "@/features/room/utils/room-path";
import { languageQuery } from "@/features/room/utils/language-preference";
import {
  DEFAULT_LISTENING_LANGUAGE,
  DEFAULT_SPEAKING_LANGUAGE,
  LANGUAGES,
  languageLabel,
} from "@/features/translation/data/languages";
import { siteConfig } from "@/config/app";
import type { RoomCode } from "@/features/room/types";
import type { LanguageCode } from "@/types";

const FACTS = [
  {
    icon: Mic,
    title: "Microphone first",
    body: "You speak normally; Sangam listens only while your turn is on.",
  },
  {
    icon: ShieldCheck,
    title: "Two people per room",
    body: "Rooms are private and limited to the pair that shares the code.",
  },
  {
    icon: Users,
    title: "No accounts",
    body: "Pick your languages, create a room, and send the code.",
  },
] as const;

/** Landing screen: choose languages, then create or join a room. */
export function LandingView() {
  const router = useRouter();
  const [spoken, setSpoken] = useState<LanguageCode>(DEFAULT_SPEAKING_LANGUAGE);
  const [heard, setHeard] = useState<LanguageCode>(DEFAULT_LISTENING_LANGUAGE);
  const [joinOpen, setJoinOpen] = useState(false);

  /**
   * Navigate to the room screen. Creators carry `create=1` so that screen
   * reserves the code through the server before reporting success; guests
   * join an existing room. Both preferences — what I speak and what I want to
   * hear — ride in the URL in the exact form the room route parses, and the
   * invite link mirrors them for the partner.
   */
  function enterRoom(code: RoomCode, create: boolean) {
    const query = languageQuery({ speaking: spoken, listening: heard });
    router.push(`${roomPath(code)}?${query}${create ? "&create=1" : ""}`);
  }

  return (
    <div className="relative flex min-h-dvh flex-col overflow-x-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      >
        <div className="bg-speaker-a/15 absolute -top-40 -left-24 size-80 rounded-full blur-3xl" />
        <div className="bg-speaker-b/15 absolute -top-24 -right-16 size-80 rounded-full blur-3xl" />
      </div>

      <header className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <Wordmark />
        <ThemeToggle />
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-10 sm:px-6">
        <section className="rise space-y-4 pt-6 text-center sm:pt-10">
          <p className="border-line text-mute inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium">
            <Sparkles aria-hidden="true" className="size-3.5" />
            {siteConfig.tagline}
          </p>
          <h1 className="font-display text-4xl font-bold tracking-tight text-balance sm:text-5xl lg:text-6xl">
            Speak your language.
            <br />
            They hear theirs.
          </h1>
          <p className="text-mute mx-auto max-w-xl text-pretty">
            {siteConfig.name} connects two people in one live room and
            translates both directions as you talk, so you never need a shared
            language to have a real conversation.
          </p>
        </section>

        <section className="rise glass shadow-soft mt-8 rounded-3xl p-4 sm:p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <LanguageSelect
              id="spoken-language"
              label="I speak"
              hint="The language you talk in."
              icon={Mic}
              value={spoken}
              onChange={setSpoken}
            />{" "}
            <LanguageSelect
              id="heard-language"
              label="I want to hear"
              hint="The language you want your partner's words in."
              icon={Headphones}
              value={heard}
              onChange={setHeard}
            />
          </div>

          <div className="border-line/70 bg-ink/[0.03] dark:bg-ink/[0.07] mt-5 flex flex-col items-center rounded-2xl border px-3 py-4">
            <VoiceBridge
              flow="a-to-b"
              label={`${languageLabel(spoken)} → ${languageLabel(heard)}`}
            />
            <div className="text-mute mt-2 flex flex-wrap items-center justify-center gap-4 text-xs">
              <span className="inline-flex items-center gap-1.5">
                <span className="bg-speaker-a size-2.5 rounded-full" />
                You speak {languageLabel(spoken)}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="bg-speaker-b size-2.5 rounded-full" />
                You hear {languageLabel(heard)} — your partner speaks it
              </span>
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-3 sm:flex-row">
            <Button
              size="lg"
              className="flex-1"
              onClick={() => enterRoom(createRoomCode(), true)}
            >
              <Sparkles aria-hidden="true" className="size-4" />
              Create conversation
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="flex-1"
              onClick={() => setJoinOpen(true)}
            >
              <KeyRound aria-hidden="true" className="size-4" />
              Join with code
            </Button>
          </div>
        </section>

        <ul className="mt-6 grid gap-3 sm:grid-cols-3">
          {FACTS.map(({ icon: Icon, title, body }) => (
            <li
              key={title}
              className="border-line bg-surface flex gap-3 rounded-2xl border p-4"
            >
              <Icon
                aria-hidden="true"
                className="text-bridge mt-0.5 size-5 shrink-0"
              />
              <div className="space-y-1">
                <p className="text-sm font-semibold">{title}</p>
                <p className="text-mute text-xs">{body}</p>
              </div>
            </li>
          ))}
        </ul>

        <p className="text-mute mt-6 text-center text-xs">
          Sangam asks for the microphone only when you start speaking, and voice
          support is on the way. {LANGUAGES.length} languages available today.{" "}
          {PREVIEW_STAGE_NOTE}
        </p>
      </main>

      <footer className="text-mute mx-auto w-full max-w-5xl px-4 py-5 text-center text-xs sm:px-6">
        Made for two people who do not share a tongue.
      </footer>

      <Dialog
        open={joinOpen}
        onClose={() => setJoinOpen(false)}
        title="Join a conversation"
        description="Enter the six-character code your partner sent you."
      >
        <JoinCodeForm
          onCancel={() => setJoinOpen(false)}
          onSubmit={(code) => {
            setJoinOpen(false);
            enterRoom(code, false);
          }}
        />
      </Dialog>
    </div>
  );
}
