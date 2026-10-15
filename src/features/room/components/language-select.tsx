"use client";

import { ChevronDown, type LucideIcon } from "lucide-react";
import { LANGUAGES } from "@/features/translation/data/languages";
import type { LanguageCode } from "@/types";
import { cn } from "@/lib/utils";

export interface LanguageSelectProps {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly icon: LucideIcon;
  readonly value: LanguageCode;
  readonly onChange: (code: LanguageCode) => void;
  readonly className?: string;
}

/**
 * Native `select` so mobile shows the platform picker and keyboard users get
 * the expected behaviour; styled to match the Sangam surfaces.
 */
export function LanguageSelect({
  id,
  label,
  hint,
  icon: Icon,
  value,
  onChange,
  className,
}: LanguageSelectProps) {
  return (
    <div className={cn("space-y-2", className)}>
      <label
        htmlFor={id}
        className="text-mute flex items-center gap-2 text-xs font-semibold tracking-wider uppercase"
      >
        <Icon aria-hidden="true" className="size-4" />
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className="border-line bg-surface shadow-soft hover:border-ink/30 min-h-12 w-full cursor-pointer appearance-none rounded-2xl border px-4 pr-10 text-sm font-medium transition-colors"
        >
          {LANGUAGES.map((language) => (
            <option key={language.code} value={language.code}>
              {language.label} — {language.native}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="text-mute pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2"
        />
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="text-mute text-xs">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
