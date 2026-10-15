"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Small queue for the simulated delays. `clear()` cancels everything pending
 * (used when a turn is interrupted), and unmounting cancels the rest so no
 * callback fires against a torn-down tree.
 */
export function useTimerQueue() {
  const timers = useRef<number[]>([]);

  const clear = useCallback(() => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
  }, []);

  const schedule = useCallback((fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);

  useEffect(() => clear, [clear]);

  return { schedule, clear } as const;
}
