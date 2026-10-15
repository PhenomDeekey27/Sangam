"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LanguageCode } from "@/types";
import type {
  MicPermission,
  RecognitionStatus,
  SpeechError,
} from "@/features/speech/types";
import {
  createBrowserRecognition,
  isSpeechRecognitionSupported,
  type BrowserRecognition,
  type RecognitionHandlers,
} from "@/features/speech/services/web-speech";
import { languageLabel } from "@/features/translation/data/languages";

/** Minimum gap between interim emissions over the socket. */
const INTERIM_EMIT_MIN_MS = 250;
/** Pause before an automatic restart after an unexpected recognition end. */
const RESTART_DELAY_MS = 300;
/** A final identical to the previous one within this window is dropped. */
const DUPLICATE_FINAL_WINDOW_MS = 2000;
/** Consecutive runs that end before any result before capture gives up. */
const MAX_RUNS_WITHOUT_RESULT = 3;
/** How long a graceful stop keeps draining the in-flight phrase. */
const STOP_DRAIN_MS = 1500;

export interface SpeechCaptureOptions {
  readonly language: LanguageCode;
  /** One finalized recognition segment, already deduplicated. */
  readonly onFinalText: (text: string) => void;
  /** Replaceable partial text, throttled; empty string clears the line. */
  readonly onInterimEmit: (text: string) => void;
  /** Status lines for the room's `aria-live` region. */
  readonly onNotice?: (message: string) => void;
}

export interface SpeechCapture {
  /** Browser exposes `SpeechRecognition`; false disables the mic button. */
  readonly supported: boolean;
  /** The user has capture on (covers starting/listening/stopping). */
  readonly capturing: boolean;
  readonly permission: MicPermission;
  /** What the browser is doing right now — never "listening" when idle. */
  readonly status: RecognitionStatus;
  readonly error: SpeechError | null;
  /** Latest local interim text; empty when nothing is being transcribed. */
  readonly interim: string;
  readonly toggle: () => void;
  /** Request a graceful stop; the in-flight phrase may still finalize. */
  readonly stop: () => void;
}

/**
 * Microphone capture through the Web Speech API: permission only on user
 * start, one session at a time, auto-restart after silence timeouts,
 * throttled interim emission, duplicate finals dropped. Unsupported
 * browsers get `supported: false` so the UI falls back to typed messages.
 */
export function useSpeechCapture({
  language,
  onFinalText,
  onInterimEmit,
  onNotice,
}: SpeechCaptureOptions): SpeechCapture {
  const [supported] = useState(() => isSpeechRecognitionSupported());
  const [capturing, setCapturing] = useState(false);
  const [permission, setPermission] = useState<MicPermission>("prompt");
  const [status, setStatus] = useState<RecognitionStatus>("idle");
  const [error, setError] = useState<SpeechError | null>(null);
  const [interim, setInterim] = useState("");

  const recognitionRef = useRef<BrowserRecognition | null>(null);
  const desiredRef = useRef(false);
  const mountedRef = useRef(true);
  const resultSeenRef = useRef(false);
  const failedRunsRef = useRef(0);
  const lastFinalRef = useRef<{ text: string; at: number } | null>(null);
  const restartTimerRef = useRef<number | null>(null);
  const stopFinalizeTimerRef = useRef<number | null>(null);
  const drainDeadlineRef = useRef(0);
  const sessionNotifiedRef = useRef(false);
  const beginSessionRef = useRef<() => void>(() => {});
  const interimEmitRef = useRef({
    lastAt: 0,
    lastText: "",
    pending: "",
    timer: null as number | null,
  });

  const onFinalRef = useRef(onFinalText);
  const onInterimEmitRef = useRef(onInterimEmit);
  const onNoticeRef = useRef(onNotice);
  const languageRef = useRef(language);

  useEffect(() => {
    onFinalRef.current = onFinalText;
    onInterimEmitRef.current = onInterimEmit;
    onNoticeRef.current = onNotice;
  }, [onFinalText, onInterimEmit, onNotice]);

  const notify = useCallback((message: string) => {
    onNoticeRef.current?.(message);
  }, []);

  const emitInterimNow = useCallback((text: string) => {
    const slot = interimEmitRef.current;
    slot.lastText = text;
    slot.lastAt = Date.now();
    onInterimEmitRef.current(text);
  }, []);

  /** Clear the interim line locally and tell the partner to clear theirs. */
  const clearInterim = useCallback(() => {
    const slot = interimEmitRef.current;
    if (slot.timer !== null) {
      window.clearTimeout(slot.timer);
      slot.timer = null;
    }
    slot.pending = "";
    if (mountedRef.current) setInterim("");
    if (slot.lastText !== "") emitInterimNow("");
  }, [emitInterimNow]);

  const teardownTimers = useCallback(() => {
    if (restartTimerRef.current !== null) {
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    if (stopFinalizeTimerRef.current !== null) {
      window.clearTimeout(stopFinalizeTimerRef.current);
      stopFinalizeTimerRef.current = null;
    }
  }, []);

  /** True while results should be processed: capturing, or draining a stop. */
  const acceptingResults = useCallback(
    () => desiredRef.current || Date.now() < drainDeadlineRef.current,
    [],
  );

  const failCapture = useCallback(
    (failure: SpeechError, permissionHit: boolean) => {
      desiredRef.current = false;
      teardownTimers();
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      clearInterim();
      if (!mountedRef.current) return;
      if (permissionHit) setPermission("denied");
      setError(failure);
      setStatus("error");
      setCapturing(false);
      notify(failure.message);
    },
    [clearInterim, notify, teardownTimers],
  );

  // One stable handler set: initial sessions and auto-restarts share it, and
  // every callback reads current values through refs.
  const handlers = useMemo<RecognitionHandlers>(
    () => ({
      onStart: () => {
        if (!mountedRef.current || !desiredRef.current) return;
        setPermission("granted");
        setStatus("listening");
        if (!sessionNotifiedRef.current) {
          sessionNotifiedRef.current = true;
          notify(
            `Microphone on — speak in ${languageLabel(languageRef.current)}. Interim words appear live; finished sentences join the transcript.`,
          );
        }
      },
      onInterim: (text) => {
        if (!mountedRef.current || !acceptingResults()) return;
        resultSeenRef.current = true;
        const slot = interimEmitRef.current;
        setInterim(text);
        slot.pending = text;
        const elapsed = Date.now() - slot.lastAt;
        if (elapsed >= INTERIM_EMIT_MIN_MS) {
          if (slot.timer !== null) {
            window.clearTimeout(slot.timer);
            slot.timer = null;
          }
          emitInterimNow(text);
          return;
        }
        if (slot.timer === null) {
          slot.timer = window.setTimeout(() => {
            slot.timer = null;
            emitInterimNow(slot.pending);
          }, INTERIM_EMIT_MIN_MS - elapsed);
        }
      },
      onFinal: (text) => {
        if (!mountedRef.current || !acceptingResults()) return;
        resultSeenRef.current = true;
        const now = Date.now();
        const previous = lastFinalRef.current;
        const duplicate =
          previous !== null &&
          previous.text === text &&
          now - previous.at < DUPLICATE_FINAL_WINDOW_MS;
        lastFinalRef.current = { text, at: now };
        clearInterim();
        if (duplicate) return;
        onFinalRef.current(text);
      },
      onError: (failure) => {
        if (!mountedRef.current || !desiredRef.current) return;
        if (failure.code === "aborted") return;
        if (failure.code === "no_speech") {
          // A silence timeout, not a failure: the session auto-restarts.
          notify(failure.message);
          return;
        }
        failCapture(failure, failure.code === "permission_denied");
      },
      onEnd: () => {
        if (!mountedRef.current) return;
        recognitionRef.current = null;
        if (!desiredRef.current) {
          teardownTimers();
          clearInterim();
          setStatus("idle");
          setCapturing(false);
          return;
        }
        if (!resultSeenRef.current) {
          failedRunsRef.current += 1;
          if (failedRunsRef.current >= MAX_RUNS_WITHOUT_RESULT) {
            failCapture(
              {
                code: "unknown",
                message:
                  "Speech recognition kept stopping before hearing anything — check your microphone, then try again.",
              },
              false,
            );
            return;
          }
        } else {
          failedRunsRef.current = 0;
        }
        resultSeenRef.current = false;
        teardownTimers();
        restartTimerRef.current = window.setTimeout(() => {
          restartTimerRef.current = null;
          if (!desiredRef.current || !mountedRef.current) return;
          beginSessionRef.current();
        }, RESTART_DELAY_MS);
      },
    }),
    [
      acceptingResults,
      clearInterim,
      emitInterimNow,
      failCapture,
      notify,
      teardownTimers,
    ],
  );

  const beginSession = useCallback(() => {
    try {
      const session = createBrowserRecognition(languageRef.current, handlers);
      recognitionRef.current = session;
      session.start();
    } catch (cause) {
      const name = cause instanceof DOMException ? cause.name : "";
      failCapture(
        name === "NotAllowedError"
          ? {
              code: "permission_denied",
              message:
                "Microphone access was blocked — allow the microphone for this site in your browser settings, then try again.",
            }
          : {
              code: "unknown",
              message:
                "The microphone could not be started — check your input device and try again.",
            },
        name === "NotAllowedError",
      );
    }
  }, [failCapture, handlers]);

  useEffect(() => {
    beginSessionRef.current = beginSession;
  }, [beginSession]);

  const start = useCallback(() => {
    if (!supported) {
      setError({
        code: "not_supported",
        message:
          "Speech recognition isn't supported in this browser — try Chrome, Edge, or Safari, or type your message below.",
      });
      notify(
        "Speech recognition isn't supported in this browser — type your message below.",
      );
      return;
    }
    if (desiredRef.current) return;
    desiredRef.current = true;
    sessionNotifiedRef.current = false;
    failedRunsRef.current = 0;
    resultSeenRef.current = false;
    setError(null);
    setCapturing(true);
    setStatus("starting");
    notify("Starting the microphone…");
    beginSession();
  }, [beginSession, notify, supported]);

  const stop = useCallback(() => {
    if (!desiredRef.current && recognitionRef.current === null) return;
    desiredRef.current = false;
    drainDeadlineRef.current = Date.now() + STOP_DRAIN_MS;
    teardownTimers();
    clearInterim();
    notify("Microphone off.");
    const session = recognitionRef.current;
    if (!session) {
      setStatus("idle");
      setCapturing(false);
      return;
    }
    setStatus("stopping");
    try {
      // Graceful stop: the current phrase may still finalize within the
      // drain window before the session winds down.
      session.stop();
    } catch {
      session.abort();
      recognitionRef.current = null;
      setStatus("idle");
      setCapturing(false);
      return;
    }
    // Safety net: some browsers never emit `end` after stop().
    stopFinalizeTimerRef.current = window.setTimeout(() => {
      stopFinalizeTimerRef.current = null;
      if (desiredRef.current || !mountedRef.current) return;
      try {
        session.abort();
      } catch {
        /* already finished */
      }
      recognitionRef.current = null;
      setStatus("idle");
      setCapturing(false);
    }, STOP_DRAIN_MS + 500);
  }, [clearInterim, notify, teardownTimers]);

  // Abort instantly on unmount — no graceful stop, no state updates after.
  useEffect(() => {
    const interimSlot = interimEmitRef.current;
    return () => {
      mountedRef.current = false;
      desiredRef.current = false;
      if (restartTimerRef.current !== null) {
        window.clearTimeout(restartTimerRef.current);
      }
      if (stopFinalizeTimerRef.current !== null) {
        window.clearTimeout(stopFinalizeTimerRef.current);
      }
      if (interimSlot.timer !== null) window.clearTimeout(interimSlot.timer);
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  // Switching the speaking language restarts an active session silently.
  useEffect(() => {
    languageRef.current = language;
    if (!desiredRef.current || !mountedRef.current) return;
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    beginSession();
  }, [language, beginSession]);

  const toggle = useCallback(() => {
    if (desiredRef.current) stop();
    else start();
  }, [start, stop]);

  return {
    supported,
    capturing,
    permission,
    status,
    error,
    interim,
    toggle,
    stop,
  };
}
