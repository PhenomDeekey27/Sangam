"use client";

import { Check, Copy, LogOut, UserPlus } from "lucide-react";
import Link from "next/link";
import { LogoMark } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { buttonClasses } from "@/components/ui/button";
import { ConnectionStatus } from "@/features/room/components/connection-status";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import type { ConnectionStatus as ConnectionState } from "@/features/room/types";
import { siteConfig } from "@/config/app";

export interface RoomHeaderProps {
  readonly code: string;
  readonly connection: ConnectionState;
  readonly onInvite: () => void;
}

/** Sticky room chrome: identity, code, connection, theme, leave. */
export function RoomHeader({ code, connection, onInvite }: RoomHeaderProps) {
  const { status, copy } = useCopyToClipboard();

  return (
    <header className="glass border-line sticky top-0 z-30 border-b">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-3 py-2 sm:px-5">
        <Link
          href="/"
          aria-label={`${siteConfig.name} home`}
          className="inline-flex items-center gap-2 rounded-full py-1 pr-2"
        >
          <LogoMark />
          <span className="font-display hidden text-base font-bold tracking-tight sm:inline">
            {siteConfig.name}
          </span>
        </Link>

        <button
          type="button"
          onClick={() => void copy(code)}
          aria-label={`Copy room code ${code}`}
          className="border-line hover:bg-ink/5 dark:hover:bg-ink/10 inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 font-mono text-sm font-semibold tracking-widest transition-colors"
        >
          {status === "copied" ? (
            <Check aria-hidden="true" className="text-success size-3.5" />
          ) : (
            <Copy aria-hidden="true" className="text-mute size-3.5" />
          )}
          {code}
        </button>

        <ConnectionStatus status={connection} className="ml-auto" />

        <button
          type="button"
          onClick={onInvite}
          aria-label="Invite your partner"
          className={buttonClasses("outline", "sm", "max-sm:px-3")}
        >
          <UserPlus aria-hidden="true" className="size-4" />
          <span className="hidden lg:inline">Invite</span>
        </button>

        <ThemeToggle compact />

        <Link
          href="/"
          aria-label="Leave the room"
          className={buttonClasses("ghost", "sm", "max-sm:px-3")}
        >
          <LogOut aria-hidden="true" className="size-4" />
          <span className="hidden lg:inline">Leave</span>
        </Link>
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {status === "copied"
          ? `Room code ${code} copied`
          : status === "error"
            ? "Could not copy the room code"
            : ""}
      </span>
    </header>
  );
}
