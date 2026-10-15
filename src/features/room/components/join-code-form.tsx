"use client";

import { ArrowRight } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  ROOM_CODE_LENGTH,
  isRoomCode,
  normalizeRoomCode,
} from "@/features/room/utils/room-code";
import type { RoomCode } from "@/features/room/types";

export interface JoinCodeFormProps {
  readonly onSubmit: (code: RoomCode) => void;
  readonly onCancel?: () => void;
}

/**
 * Validates a pasted code with the shared room-code utility — no duplicate
 * rules — and reports invalid input inline.
 */
export function JoinCodeForm({ onSubmit, onCancel }: JoinCodeFormProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = normalizeRoomCode(value);
    if (!isRoomCode(normalized)) {
      setError(
        `Codes are ${ROOM_CODE_LENGTH} characters and skip look-alike letters. Check the code and try again.`,
      );
      return;
    }
    setError(null);
    onSubmit(normalized);
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <div className="space-y-2">
        <label
          htmlFor="join-code"
          className="text-mute text-xs font-semibold tracking-wider uppercase"
        >
          Room code
        </label>
        <input
          id="join-code"
          data-autofocus
          value={value}
          onChange={(event) => {
            setValue(event.target.value.toUpperCase());
            if (error) setError(null);
          }}
          inputMode="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={ROOM_CODE_LENGTH + 2}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "join-code-error" : "join-code-hint"}
          placeholder="ABC123"
          className="border-line bg-surface shadow-soft placeholder:text-mute min-h-12 w-full rounded-2xl border px-4 font-mono text-lg tracking-[0.3em]"
        />
        {error ? (
          <p id="join-code-error" role="alert" className="text-danger text-sm">
            {error}
          </p>
        ) : (
          <p id="join-code-hint" className="text-mute text-xs">
            Six characters, shared by the person who created the room.
          </p>
        )}
      </div>

      <div className="flex gap-2">
        <Button type="submit" size="lg" className="flex-1">
          Join room
          <ArrowRight aria-hidden="true" className="size-4" />
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" size="lg" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
