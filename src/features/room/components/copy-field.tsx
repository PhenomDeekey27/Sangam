"use client";

import { Check, CircleAlert, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

export interface CopyFieldProps {
  /** Text written to the clipboard. */
  readonly value: string;
  /** Small caption above the value. */
  readonly label: string;
  /** What to show; defaults to `value`. */
  readonly display?: string;
  readonly className?: string;
}

/** Copyable code or link with clear success and error feedback. */
export function CopyField({
  value,
  label,
  display,
  className,
}: CopyFieldProps) {
  const { status, copy } = useCopyToClipboard();

  const feedback =
    status === "copied"
      ? "Copied"
      : status === "error"
        ? "Copy failed"
        : "Copy";

  return (
    <div
      className={cn(
        "border-line bg-ink/[0.03] dark:bg-ink/[0.07] flex items-center gap-2 rounded-2xl border p-2 pl-3",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-mute text-[10px] font-semibold tracking-wider uppercase">
          {label}
        </p>
        <p className="truncate text-sm font-semibold tracking-wide">
          {display ?? value}
        </p>
      </div>
      <Button
        variant={status === "copied" ? "secondary" : "outline"}
        size="sm"
        onClick={() => void copy(value)}
        aria-label={`${feedback}: ${label}`}
      >
        {status === "copied" ? (
          <Check aria-hidden="true" className="size-4" />
        ) : status === "error" ? (
          <CircleAlert aria-hidden="true" className="size-4" />
        ) : (
          <Copy aria-hidden="true" className="size-4" />
        )}
        <span>{feedback}</span>
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {status === "idle" ? "" : feedback}
      </span>
    </div>
  );
}
