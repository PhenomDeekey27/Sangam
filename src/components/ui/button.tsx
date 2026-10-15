import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/** Visual treatments shared by buttons and button-shaped links. */
export type ButtonVariant =
  "primary" | "secondary" | "ghost" | "outline" | "danger";

export type ButtonSize = "sm" | "md" | "lg" | "icon";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-bridge text-white shadow-soft hover:brightness-110 active:brightness-95 dark:text-[#12102a]",
  secondary: "bg-ink text-bg hover:opacity-90",
  ghost: "text-ink hover:bg-ink/5 dark:hover:bg-ink/10",
  outline: "border border-line text-ink hover:bg-ink/5 dark:hover:bg-ink/10",
  danger: "border border-danger/50 text-danger hover:bg-danger-soft",
};

/*
 * Every size keeps a >=44px touch target (Sangam accessibility rule).
 * `icon` is square; `sm`/`md` grow horizontally for label length.
 */
const SIZES: Record<ButtonSize, string> = {
  sm: "min-h-11 px-3 text-sm gap-1.5",
  md: "min-h-11 px-4 text-sm gap-2",
  lg: "min-h-12 px-6 text-base gap-2",
  icon: "size-11 shrink-0 justify-center",
};

/** Compose the shared button classes so links can look like buttons too. */
export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  extra?: string,
): string {
  return cn(
    "inline-flex items-center rounded-full font-medium whitespace-nowrap transition-[transform,filter,background-color,opacity] duration-150 select-none active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45",
    VARIANTS[variant],
    SIZES[size],
    extra,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

/** The one button used across the app; renders a native `button`. */
export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClasses(variant, size, className)}
      {...props}
    />
  );
}
