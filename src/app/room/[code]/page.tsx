import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { RoomView } from "@/features/room/components/room-view";
import { isRoomCode, normalizeRoomCode } from "@/features/room/utils/room-code";
import {
  DEFAULT_HEARD_LANGUAGE,
  DEFAULT_SPOKEN_LANGUAGE,
  findLanguage,
} from "@/features/translation/data/languages";
import type { RoomMode } from "@/features/room/types";
import type { LanguageCode } from "@/types";

export const metadata: Metadata = {
  title: "Room",
};

/** Accept only codes Sangam actually offers; otherwise use the default. */
function pickLanguage(
  value: string | string[] | undefined,
  fallback: LanguageCode,
): LanguageCode {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && findLanguage(candidate) ? candidate : fallback;
}

/**
 * `?create=1` marks the creator's own navigation: that screen reserves the
 * room through `room:create` instead of joining an existing one. Anything
 * else joins, so an invite link can never create a phantom room.
 */
function pickMode(value: string | string[] | undefined): RoomMode {
  return value === "1" ? "create" : "join";
}

/**
 * URL data (`params`, `searchParams`) must be read inside a `<Suspense>`
 * boundary, so the route keeps a shared static app shell and only the room
 * itself streams in once the code and language preferences are known.
 */
export default function RoomPage({
  params,
  searchParams,
}: PageProps<"/room/[code]">) {
  return (
    <Suspense fallback={<RoomShell />}>
      <RoomContent params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function RoomContent({
  params,
  searchParams,
}: Pick<PageProps<"/room/[code]">, "params" | "searchParams">) {
  const { code } = await params;

  if (!isRoomCode(code)) {
    notFound();
  }

  const query = await searchParams;

  return (
    <RoomView
      code={normalizeRoomCode(code)}
      mode={pickMode(query.create)}
      youLanguage={pickLanguage(query.speak, DEFAULT_SPOKEN_LANGUAGE)}
      partnerLanguage={pickLanguage(query.hear, DEFAULT_HEARD_LANGUAGE)}
    />
  );
}

/** Minimal shell shown while the room's URL data resolves. */
function RoomShell() {
  return (
    <div className="flex min-h-dvh flex-col" aria-busy="true">
      <div className="glass border-line h-15 border-b" />
      <div className="mx-auto w-full max-w-6xl flex-1 px-3 py-4 sm:px-5">
        <p role="status" aria-live="polite" className="text-mute text-sm">
          Opening the room…
        </p>
      </div>
    </div>
  );
}
