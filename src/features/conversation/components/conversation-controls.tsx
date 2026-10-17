import { Hand, Loader2, Mic, MicOff, Square, VolumeX } from "lucide-react";
import type { MicPermission, RecognitionStatus } from "@/features/speech/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ConversationControlsProps {
  readonly capturing: boolean;
  readonly mic: MicPermission;
  /** Browser recognition status; "starting" shows a pending mic state. */
  readonly recognitionStatus?: RecognitionStatus;
  readonly playing: boolean;
  readonly canInterrupt: boolean;
  /** Phase-aware copy for the interrupt button (Ready/Interrupting…/Retry…). */
  readonly interruptLabel?: string;
  /** A request is in flight: the button shows a spinner and stays disabled. */
  readonly interruptPending?: boolean;
  readonly disabled?: boolean;
  readonly onToggleCapture: () => void;
  readonly onStopPlayback: () => void;
  readonly onInterrupt: () => void;
  readonly className?: string;
}

/**
 * Bottom conversation controls. The microphone is a 56px target (design
 * minimum) that emits expanding rings while the microphone is on, and shows
 * a pending state while the browser is still starting recognition. The
 * interrupt button reports its own phase so a click never reads as a
 * completed cancellation.
 */
export function ConversationControls({
  capturing,
  mic,
  recognitionStatus = "idle",
  playing,
  canInterrupt,
  interruptLabel = "Interrupt",
  interruptPending = false,
  disabled = false,
  onToggleCapture,
  onStopPlayback,
  onInterrupt,
  className,
}: ConversationControlsProps) {
  const blocked = mic === "denied" || mic === "unavailable";
  const starting = capturing && recognitionStatus === "starting";
  const MicIcon = mic === "unavailable" ? MicOff : capturing ? Square : Mic;

  return (
    <div className={cn("flex flex-wrap items-center gap-3", className)}>
      <div className="relative inline-flex items-center justify-center">
        {capturing ? (
          <>
            <span
              aria-hidden="true"
              className="bg-speaker-a/40 absolute inset-0 rounded-full ring"
            />
            <span
              aria-hidden="true"
              className="bg-speaker-a/40 absolute inset-0 rounded-full ring ring-2"
            />
          </>
        ) : null}
        <button
          type="button"
          onClick={onToggleCapture}
          disabled={disabled || mic === "unavailable"}
          aria-pressed={capturing}
          aria-label={
            mic === "unavailable"
              ? "Speech recognition is not available in this browser — type your message instead"
              : blocked
                ? "Microphone blocked — allow microphone access in your browser settings"
                : capturing
                  ? "Turn off the microphone"
                  : "Turn on the microphone"
          }
          className={cn(
            "relative z-10 inline-flex size-14 items-center justify-center rounded-full transition-transform duration-150 active:scale-95 disabled:opacity-45",
            capturing
              ? "bg-speaker-a text-on-a shadow-lift"
              : "bg-ink text-bg shadow-soft",
            blocked && !capturing && "border-danger border border-dashed",
          )}
        >
          {starting ? (
            <Loader2 aria-hidden="true" className="blink size-6" />
          ) : (
            <MicIcon aria-hidden="true" className="size-6" />
          )}
        </button>
      </div>

      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <Button
          variant="outline"
          onClick={onStopPlayback}
          disabled={disabled || !playing}
        >
          <VolumeX aria-hidden="true" className="size-4" />
          Stop playback
        </Button>
        <Button
          variant="outline"
          onClick={onInterrupt}
          disabled={disabled || !canInterrupt || interruptPending}
          aria-busy={interruptPending}
        >
          {interruptPending ? (
            <Loader2 aria-hidden="true" className="blink size-4" />
          ) : (
            <Hand aria-hidden="true" className="size-4" />
          )}
          {interruptLabel}
        </Button>
      </div>
    </div>
  );
}
