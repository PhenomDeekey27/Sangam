/**
 * Format an epoch timestamp as a short local clock time.
 * Locale-dependent, so callers render it inside an element marked with
 * `suppressHydrationWarning`.
 */
export function formatClockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}
