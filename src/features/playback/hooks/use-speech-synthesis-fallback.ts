"use client";

import { useCallback, useEffect, useState } from "react";
import type { PlaybackUnavailablePayload } from "@/types/socket";
import { SpeechSynthesisFallback } from "@/features/playback/services/speech-synthesis";

/** Stable handles for the browser speech fallback, safe in socket callbacks. */
export interface SpeechSynthesisFallbackApi {
  /** Speak one translated line locally (dedup + ordering applied). */
  readonly speak: (payload: PlaybackUnavailablePayload) => void;
  /** Drop the interrupted turn at or below this server boundary. */
  readonly interrupt: (sequence: number) => void;
  /** Forget everything on a disconnect, leave, or room change. */
  readonly reset: () => void;
  /** True when this browser can speak text at all. */
  readonly supported: boolean;
}

export interface UseSpeechSynthesisFallbackOptions {
  /**
   * Translated text for one utterance id, or `null` while unavailable. Freshly
   * installed on every render so the caller may update entries without
   * re-creating the fallback (and losing its ordering watermark).
   */
  readonly getText: (utteranceId: string) => string | null;
}

/**
 * Owns the browser `speechSynthesis` fallback for one room seat and exposes
 * stable callbacks. Client-only, so no synthesiser is touched during server
 * rendering; kept for the mount's lifetime so the played watermark survives
 * re-renders.
 */
export function useSpeechSynthesisFallback(
  options: UseSpeechSynthesisFallbackOptions,
): SpeechSynthesisFallbackApi {
  // Created once per mount (client components only), so the played watermark
  // survives re-renders. The transcript lookup is swapped in an effect, keeping
  // the freshest closure without reading a ref during render.
  const [fallback] = useState(
    () => new SpeechSynthesisFallback({ getText: () => null }),
  );
  useEffect(() => {
    fallback.setGetText(options.getText);
  });
  const speak = useCallback(
    (payload: PlaybackUnavailablePayload) => {
      fallback.enqueue(payload);
    },
    [fallback],
  );
  const interrupt = useCallback(
    (sequence: number) => {
      fallback.interrupt(sequence);
    },
    [fallback],
  );
  const reset = useCallback(() => {
    fallback.reset();
  }, [fallback]);
  return {
    speak,
    interrupt,
    reset,
    supported: fallback.supported,
  };
}
