import { Compass } from "lucide-react";
import Link from "next/link";
import { Wordmark } from "@/components/brand/logo";
import { buttonClasses } from "@/components/ui/button";
import { ROOM_CODE_LENGTH } from "@/features/room/utils/room-code";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <Wordmark />
      <div className="space-y-2">
        <h1 className="font-display text-3xl font-bold tracking-tight">
          That room isn&apos;t open
        </h1>
        <p className="text-mute max-w-md text-balance">
          The code may be mistyped or the room has already closed. Codes are{" "}
          {ROOM_CODE_LENGTH} characters and leave out look-alike letters such as
          O and 1.
        </p>
      </div>
      <Link href="/" className={buttonClasses("primary", "lg")}>
        <Compass aria-hidden="true" className="size-4" />
        Back to Sangam
      </Link>
    </main>
  );
}
