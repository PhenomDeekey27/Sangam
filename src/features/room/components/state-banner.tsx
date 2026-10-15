import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type BannerTone = "info" | "warning" | "error" | "success";

const TONES: Record<BannerTone, string> = {
  info: "border-line bg-ink/5 text-ink",
  warning: "border-line bg-danger-soft text-ink",
  error: "border-danger/50 bg-danger-soft text-ink",
  success: "border-success/40 bg-success/10 text-ink",
};

export interface StateBannerProps {
  readonly tone?: BannerTone;
  readonly icon: LucideIcon;
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
}

/**
 * Inline explanation for a non-default state (waiting, mic denied, connection
 * failure). Always states what happened in words, never colour alone.
 */
export function StateBanner({
  tone = "info",
  icon: Icon,
  title,
  children,
  action,
  className,
}: StateBannerProps) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex flex-wrap items-start gap-3 rounded-2xl border px-4 py-3 text-sm",
        TONES[tone],
        className,
      )}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <div className="min-w-[12rem] flex-1 space-y-1">
        <p className="font-medium">{title}</p>
        {children ? <div className="text-mute">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
