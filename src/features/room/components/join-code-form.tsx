"use client";

import { ArrowRight, Headphones, Mic } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { LanguageSelect } from "@/features/room/components/language-select";
import { useRoomLookup } from "@/features/room/hooks/use-room-lookup";
import {
  ROOM_CODE_LENGTH,
  isRoomCode,
  normalizeRoomCode,
} from "@/features/room/utils/room-code";
import type { RoomCode } from "@/features/room/types";
import type { LanguagePreferences } from "@/features/room/utils/language-preference";
import {
  DEFAULT_LISTENING_LANGUAGE,
  DEFAULT_SPEAKING_LANGUAGE,
  languageLabel,
} from "@/features/translation/data/languages";
import type { LanguageCode } from "@/types";

export interface JoinCodeFormProps {
  readonly onSubmit: (code: RoomCode, preferences: LanguagePreferences) => void;
  readonly onCancel?: () => void;
  /** Prefill for the pre-join selectors; defaults to English/English. */
  readonly initialSpeaking?: LanguageCode;
  readonly initialListening?: LanguageCode;
}

/**
 * Code + pre-join language choice. The code is validated with the shared
 * room-code utility and the languages reuse the same selectors and
 * definitions as the landing screen — no duplicate rules. Once a valid code
 * is entered, the room server (the source of truth for the creator's stored
 * pair) is asked for it and the mirrored pair becomes the selectors' values,
 * unless already edited by hand. `LanguageSelect` only offers supported
 * codes, so the submitted pair is always valid; the `room:join` round trip
 * remains authoritative for membership.
 */
export function JoinCodeForm({
  onSubmit,
  onCancel,
  initialSpeaking = DEFAULT_SPEAKING_LANGUAGE,
  initialListening = DEFAULT_LISTENING_LANGUAGE,
}: JoinCodeFormProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState<LanguageCode>(initialSpeaking);
  const [listening, setListening] = useState<LanguageCode>(initialListening);
  const editedRef = useRef(false);

  const normalized = normalizeRoomCode(value);
  const lookupCode = isRoomCode(normalized) ? normalized : null;
  const { lookup, lookingUp } = useRoomLookup(lookupCode);

  // Adopt the mirrored pair once, unless the user already chose by hand.
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
      ? `Room ${normalized}: speaking ${languageLabel(lookup.guest.speaking)}, hearing ${languageLabel(lookup.guest.listening)} — mirrored from the creator. You can change these before joining.`
      : null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isRoomCode(normalized)) {
      setError(
        `Codes are ${ROOM_CODE_LENGTH} characters and skip look-alike letters. Check the code and try again.`,
      );
      return;
    }
    if (blockingError) {
      setError(blockingError);
      return;
    }
    setError(null);
    onSubmit(normalized, { speaking, listening });
  }

  const visibleError = error ?? blockingError;

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
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
          aria-invalid={visibleError ? true : undefined}
          aria-describedby={visibleError ? "join-code-error" : "join-code-hint"}
          placeholder="ABC123"
          className="border-line bg-surface shadow-soft placeholder:text-mute min-h-12 w-full rounded-2xl border px-4 font-mono text-lg tracking-[0.3em]"
        />
        {visibleError ? (
          <p id="join-code-error" role="alert" className="text-danger text-sm">
            {visibleError}
          </p>
        ) : (
          <p id="join-code-hint" className="text-mute text-xs">
            {lookingUp
              ? "Looking up the room's languages…"
              : (mirroredNote ??
                "Six characters, shared by the person who created the room. The room's languages load automatically — the invite link fills them in too.")}
          </p>
        )}
        {lookupWarning && !visibleError ? (
          <p className="text-mute text-xs">{lookupWarning}</p>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <LanguageSelect
          id="join-speaking"
          label="I speak"
          hint="The language you talk in."
          icon={Mic}
          value={speaking}
          onChange={(code) => {
            editedRef.current = true;
            setSpeaking(code);
          }}
        />
        <LanguageSelect
          id="join-listening"
          label="I want to hear"
          hint="The language you want your partner's words in."
          icon={Headphones}
          value={listening}
          onChange={(code) => {
            editedRef.current = true;
            setListening(code);
          }}
        />
      </div>

      <div className="flex gap-2">
        <Button
          type="submit"
          size="lg"
          className="flex-1"
          disabled={blockingError !== null}
        >
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
