"use client";

import { Laptop, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useHydrated } from "@/hooks/use-hydrated";
import { cn } from "@/lib/utils";

type Choice = "light" | "system" | "dark";

const ORDER: readonly Choice[] = ["light", "system", "dark"];

const LABELS: Record<Choice, string> = {
  light: "Light theme",
  system: "System theme",
  dark: "Dark theme",
};

const ICONS: Record<Choice, typeof Sun> = {
  light: Sun,
  system: Laptop,
  dark: Moon,
};

export interface ThemeToggleProps {
  /** Icon-only cycling button for tight headers; segmented control otherwise. */
  readonly compact?: boolean;
}

/**
 * Theme control with the next-themes provider. Renders a stable placeholder
 * until mounted so the server and first client paint agree (no flash, no
 * hydration warning).
 */
export function ThemeToggle({ compact = false }: ThemeToggleProps) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const mounted = useHydrated();

  const active: Choice = mounted
    ? ((theme === "light" || theme === "dark" || theme === "system"
        ? theme
        : "system") as Choice)
    : "system";

  if (compact) {
    const next = ORDER[(ORDER.indexOf(active) + 1) % ORDER.length];
    const CurrentIcon = ICONS[active];
    return (
      <button
        type="button"
        onClick={() => setTheme(next)}
        aria-label={`${LABELS[active]}. Switch to ${LABELS[next].toLowerCase()}.`}
        title={`${LABELS[active]} — click for ${LABELS[next].toLowerCase()}`}
        className="border-line text-ink hover:bg-ink/5 dark:hover:bg-ink/10 inline-flex size-11 items-center justify-center rounded-full border transition-colors"
      >
        <CurrentIcon aria-hidden="true" className="size-5" />
      </button>
    );
  }

  return (
    <div
      role="group"
      aria-label="Color theme"
      className="glass inline-flex items-center gap-1 rounded-full p-1"
    >
      {ORDER.map((choice) => {
        const Icon = ICONS[choice];
        const isActive = mounted && active === choice;
        return (
          <button
            key={choice}
            type="button"
            onClick={() => setTheme(choice)}
            aria-label={LABELS[choice]}
            aria-pressed={isActive}
            className={cn(
              "inline-flex size-11 items-center justify-center rounded-full transition-colors",
              isActive
                ? "bg-ink text-bg"
                : "text-mute hover:bg-ink/5 hover:text-ink dark:hover:bg-ink/10",
            )}
          >
            <Icon aria-hidden="true" className="size-4.5" />
          </button>
        );
      })}
      <span className="sr-only" role="status" aria-live="polite">
        {mounted && resolvedTheme
          ? `Resolved theme: ${resolvedTheme}`
          : "Theme loading"}
      </span>
    </div>
  );
}
