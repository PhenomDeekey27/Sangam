"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { buttonClasses } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface DialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
}

/**
 * Minimal modal: portalled to `body` so sticky docks never clip it, closes on
 * Escape and backdrop click, locks background scroll, and moves focus inside.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    /* Prefer a field so a form dialog is immediately typeable; fall back to
       the first control (usually the close button) when there is none. */
    const focusTimer = window.setTimeout(() => {
      const panel = panelRef.current;
      const field = panel?.querySelector<HTMLElement>(
        "[data-autofocus], input, textarea, select",
      );
      (field ?? panel?.querySelector<HTMLElement>("button, a[href]"))?.focus();
    }, 30);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      window.clearTimeout(focusTimer);
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6"
      role="presentation"
    >
      <button
        type="button"
        aria-label="Close dialog"
        tabIndex={-1}
        onClick={onClose}
        className="bg-ink/40 absolute inset-0 cursor-default backdrop-blur-[2px]"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className={cn(
          "glass-strong pop shadow-lift relative z-10 w-full max-w-md rounded-t-3xl p-6 sm:rounded-3xl",
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2
              id={titleId}
              className="font-display text-lg font-semibold tracking-tight"
            >
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="text-mute text-sm">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={buttonClasses("ghost", "icon", "-mt-1 -mr-1")}
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </div>
        {children ? <div className="mt-5">{children}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
