import { cn } from "@/lib/utils";
import { siteConfig } from "@/config/app";

/**
 * The Sangam mark: two speaker nodes joined by the Voice Bridge arch.
 * Uses design tokens so it re-themes automatically.
 */
export function LogoMark({ className }: { readonly className?: string }) {
  return (
    <svg
      viewBox="0 0 36 36"
      aria-hidden="true"
      className={cn("size-7", className)}
    >
      <path
        d="M6 27 Q 18 6 30 27"
        fill="none"
        stroke="var(--bridge)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="2 5"
      />
      <circle cx="6" cy="27" r="4" fill="var(--speaker-a)" />
      <circle cx="30" cy="27" r="4" fill="var(--speaker-b)" />
    </svg>
  );
}

/** Mark + wordmark lockup. `tone` switches the label color for on-brand panels. */
export function Wordmark({ className }: { readonly className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark />
      <span className="font-display text-lg font-bold tracking-tight">
        {siteConfig.name}
      </span>
    </span>
  );
}
