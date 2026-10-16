import { CircleAlert, Loader2, Wifi, WifiOff } from "lucide-react";
import type { ConnectionStatus } from "@/features/room/types";
import { cn } from "@/lib/utils";

const PRESENTATION: Record<
  ConnectionStatus,
  { readonly label: string; readonly tone: string; readonly icon: typeof Wifi }
> = {
  connecting: {
    label: "Connecting",
    tone: "text-mute",
    icon: Loader2,
  },
  reconnecting: {
    label: "Reconnecting",
    tone: "text-mute",
    icon: Loader2,
  },
  expired: {
    label: "Room ended",
    tone: "text-danger",
    icon: CircleAlert,
  },
  connected: { label: "Live", tone: "text-success", icon: Wifi },
  failed: {
    label: "Connection failed",
    tone: "text-danger",
    icon: CircleAlert,
  },
  disconnected: { label: "Disconnected", tone: "text-danger", icon: WifiOff },
};

/** Compact connection pill for the room header. */
export function ConnectionStatus({
  status,
  className,
}: {
  readonly status: ConnectionStatus;
  readonly className?: string;
}) {
  const { label, tone, icon: Icon } = PRESENTATION[status];
  const spinning = status === "connecting" || status === "reconnecting";

  return (
    <span
      role="status"
      aria-label={`Connection: ${label}`}
      className={cn(
        "border-line inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium",
        tone,
        className,
      )}
    >
      <Icon aria-hidden="true" className={cn("size-4", spinning && "blink")} />
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
}
