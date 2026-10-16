"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchRoomLookup,
  type RoomLookup,
} from "@/features/room/services/room-lookup";

export interface RoomLookupState {
  /** Latest lookup outcome for the current code, or `null` while none ran. */
  readonly lookup: RoomLookup | null;
  readonly lookingUp: boolean;
  /** Re-run the lookup for the same code (error retry). */
  readonly refresh: () => void;
}

/**
 * Look up a room code's creator preferences for a code-only join. Shared by
 * the landing join dialog and the bare-URL pre-join screen so neither
 * duplicates fetch/abort/race handling. A `null` code runs nothing; every
 * code change aborts the in-flight request so a slow reply can never
 * overwrite the current code's result. Results are keyed by code, so a
 * previous code's answer is never shown for the current one.
 */
export function useRoomLookup(code: string | null): RoomLookupState {
  const [cycle, setCycle] = useState(0);
  const [stored, setStored] = useState<{
    readonly code: string;
    readonly cycle: number;
    readonly lookup: RoomLookup;
  } | null>(null);

  const refresh = useCallback(() => setCycle((token) => token + 1), []);

  useEffect(() => {
    if (code === null) return;
    const controller = new AbortController();
    const requestCode = code;
    const requestCycle = cycle;
    const store = (lookup: RoomLookup): void => {
      if (!controller.signal.aborted) {
        setStored({ code: requestCode, cycle: requestCycle, lookup });
      }
    };
    void fetchRoomLookup(requestCode, controller.signal).then(store, () =>
      store({
        status: "failed",
        code: "lookup_failed",
        message:
          "Could not look up this room's languages — you can still join with the languages below.",
        blocking: false,
      }),
    );
    return () => controller.abort();
  }, [code, cycle]);

  const current =
    code !== null &&
    stored !== null &&
    stored.code === code &&
    stored.cycle === cycle
      ? stored.lookup
      : null;
  return {
    lookup: current,
    lookingUp: code !== null && current === null,
    refresh,
  };
}
