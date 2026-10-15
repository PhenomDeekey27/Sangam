"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Outcome of the most recent copy attempt. */
export type CopyStatus = "idle" | "copied" | "error";

/**
 * Copy text to the clipboard with transient success/error feedback.
 * Falls back to a hidden textarea when the async Clipboard API is unavailable,
 * and clears its reset timer on unmount.
 */
export function useCopyToClipboard(resetMs = 2200) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(
    async (text: string) => {
      window.clearTimeout(timer.current);
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const area = document.createElement("textarea");
          area.value = text;
          area.setAttribute("readonly", "");
          area.style.position = "fixed";
          area.style.opacity = "0";
          document.body.appendChild(area);
          area.select();
          document.execCommand("copy");
          document.body.removeChild(area);
        }
        setStatus("copied");
      } catch {
        setStatus("error");
      }
      timer.current = window.setTimeout(() => setStatus("idle"), resetMs);
    },
    [resetMs],
  );

  return { status, copy } as const;
}
