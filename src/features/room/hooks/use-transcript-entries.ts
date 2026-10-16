"use client";

import { useCallback, useRef, useState } from "react";
import type { TranscriptEntry } from "@/features/conversation/types";
import { mergeTranscriptHistory } from "@/features/conversation/utils/transcript-history";

export interface TranscriptEntriesApi {
  readonly entries: readonly TranscriptEntry[];
  /** Apply one finalized utterance; `false` when its id was already stored. */
  readonly applyUtterance: (entry: TranscriptEntry) => boolean;
  /** Merge a replayed history slice for the room this client is in. */
  readonly applyHistory: (history: readonly TranscriptEntry[]) => void;
}

/**
 * Transcript rows for the current room screen.
 *
 * Both live messages and replayed history funnel through one id set, so a row
 * can never appear twice — neither when the server replays a room's history to
 * a rejoining seat, nor when the same utterance arrives on two paths.
 */
export function useTranscriptEntries(): TranscriptEntriesApi {
  const [entries, setEntries] = useState<readonly TranscriptEntry[]>([]);
  const entryIdsRef = useRef(new Set<string>());

  const applyUtterance = useCallback((entry: TranscriptEntry): boolean => {
    const id = entry.utterance.id;
    if (entryIdsRef.current.has(id)) return false;
    entryIdsRef.current.add(id);
    setEntries((previous) => [...previous, entry]);
    return true;
  }, []);

  const applyHistory = useCallback(
    (history: readonly TranscriptEntry[]): void => {
      if (history.length === 0) return;
      for (const entry of history) entryIdsRef.current.add(entry.utterance.id);
      setEntries((previous) => mergeTranscriptHistory(previous, history));
    },
    [],
  );

  return { entries, applyUtterance, applyHistory };
}
