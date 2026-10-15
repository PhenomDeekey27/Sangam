"use client";

import { SendHorizontal } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const MAX_LENGTH = 280;

export interface TextComposerProps {
  readonly disabled?: boolean;
  readonly onSend: (text: string) => void;
  readonly className?: string;
}

/**
 * Text fallback for a denied microphone or a quiet room. Prefixes nothing and
 * fakes nothing — the room labels the resulting translation as simulated.
 */
export function TextComposer({
  disabled = false,
  onSend,
  className,
}: TextComposerProps) {
  const [value, setValue] = useState("");
  const trimmed = value.trim();
  const canSend = !disabled && trimmed.length > 0;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSend) return;
    onSend(trimmed);
    setValue("");
  }

  return (
    <form
      onSubmit={submit}
      className={cn(
        "border-line bg-surface flex items-end gap-2 rounded-3xl border p-2 pl-4",
        className,
      )}
    >
      <label htmlFor="composer-input" className="sr-only">
        Type a message
      </label>
      <textarea
        id="composer-input"
        rows={1}
        value={value}
        maxLength={MAX_LENGTH}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder={
          disabled
            ? "Reconnect to keep the conversation going"
            : "Type instead of speaking…"
        }
        className="placeholder:text-mute field-sizing-content max-h-32 min-h-11 min-w-0 flex-1 resize-none bg-transparent py-2.5 text-sm leading-relaxed outline-none disabled:opacity-60"
      />
      <Button
        type="submit"
        size="icon"
        disabled={!canSend}
        aria-label="Send typed message"
        className="rounded-full"
      >
        <SendHorizontal aria-hidden="true" className="size-5" />
      </Button>
    </form>
  );
}
