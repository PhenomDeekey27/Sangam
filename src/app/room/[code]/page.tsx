import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { RoomView } from "@/features/room/components/room-view";
import {
  hasLanguageParams,
  readLanguagePreferences,
} from "@/features/room/utils/language-preference";
import { isRoomCode, normalizeRoomCode } from "@/features/room/utils/room-code";
import type { RoomMode } from "@/features/room/types";

export const metadata: Metadata = {
  title: "Room",
};

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
 *
 * Both language preferences are read here — `speak` (this participant's own
 * language) and `hear` (what they want to hear) — and validated against the
 * supported list. A supported selection is always preserved; defaults apply
 * only when the parameter is missing or invalid. A bare `/room/CODE` URL
 * with neither parameter (code-only join, no invite link) flags a pre-join
 * language choice instead of joining silently with defaults; invite links
 * always carry both parameters and join directly.
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
      preferences={readLanguagePreferences(query)}
      requiresLanguageChoice={!hasLanguageParams(query)}
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
