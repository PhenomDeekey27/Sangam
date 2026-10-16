"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { LanguageCode } from "@/types";
import type {
  MicPermission,
  RecognitionStatus,
  SpeechError,
  SpeechSupport,
  SpeechTransport,
  CaptureController,
} from "@/features/speech/types";
import { isSpeechRecognitionSupported } from "@/features/speech/services/web-speech";
import {
  CaptureSession,
  type CaptureEvents,
} from "@/features/speech/services/capture-session";
import { ServerCaptureSession } from "@/features/speech/services/server-capture-session";
import { isMicCaptureSupported } from "@/features/speech/services/mic-capture";
import {
  getServerSpeechCapabilities,
  getSpeechCapabilities,
  subscribeSpeechCapabilities,
} from "@/features/speech/services/speech-capabilities";
import type { RoomSocket } from "@/features/room/services/socket";
import { languageLabel } from "@/features/translation/data/languages";
import { env, type SpeechTransportPreference } from "@/config/env";

/** Feature detection runs in the browser only, so the server render defers. */
const subscribeToNothing = () => () => {};
const readBrowserSupport = (): SpeechSupport =>
  isSpeechRecognitionSupported() ? "supported" : "unsupported";
const readSupportOnServer = (): SpeechSupport => "checking";

/** The two independent inputs a transport choice depends on. */
export interface TransportInputs {
  readonly preference: SpeechTransportPreference;
  /** The browser exposes `SpeechRecognition`. */
  readonly browserReady: boolean;
  /** The server advertised a streaming provider and the mic can be captured. */
  readonly serverReady: boolean;
}

/**
 * Pick the pipeline. `auto` prefers the server (browser-independent) and only
 * drops to the browser's own recognition when no server provider is configured;
 * an explicit preference never silently uses the other pipeline — it reports
 * `none` so the UI can be honest about what the user asked for.
 */
export function selectTransport({
  preference,
  browserReady,
  serverReady,
}: TransportInputs): SpeechTransport {
  if (preference === "browser") return browserReady ? "browser" : "none";
  if (preference === "server") return serverReady ? "server" : "none";
  if (serverReady) return "server";
  return browserReady ? "browser" : "none";
}

export interface SpeechCaptureOptions {
  readonly language: LanguageCode;
  /** One finalized recognition segment, already deduplicated. */
  readonly onFinalText: (text: string) => void;
  /** Replaceable partial text, throttled; empty string clears the line. */
  readonly onInterimEmit: (text: string) => void;
  /** Status lines for the room's `aria-live` region. */
  readonly onNotice?: (message: string) => void;
  /** Room socket accessor for the server pipeline; `null` disables it. */
  readonly getSocket?: () => RoomSocket | null;
}

export interface SpeechCapture {
  /** `checking` until the client has feature-detected a pipeline. */
  readonly support: SpeechSupport;
  /** Where recognition actually runs for this session. */
  readonly transport: SpeechTransport;
  /** The user has capture on (covers starting/listening/stopping). */
  readonly capturing: boolean;
  readonly permission: MicPermission;
  /** What recognition is doing right now — never "listening" when idle. */
  readonly status: RecognitionStatus;
  readonly error: SpeechError | null;
  /** Latest local interim text; empty when nothing is being transcribed. */
  readonly interim: string;
  readonly toggle: () => void;
  /** Request a graceful stop; the in-flight phrase may still finalize. */
  readonly stop: () => void;
}

/** A capture session plus the transport it was created for. */
interface ActiveCapture {
  readonly transport: SpeechTransport;
  readonly controller: CaptureController;
}

function unavailableError(preference: SpeechTransportPreference): SpeechError {
  if (preference === "server") {
    return {
      code: "speech_unavailable",
      message:
        "Server speech recognition is unavailable — use the text composer below, or ask the operator to configure a provider.",
    };
  }
  return {
    code: "not_supported",
    message:
      "Speech recognition isn't supported in this browser — try Chrome, Edge, or Safari, or type your message below.",
  };
}

/**
 * Microphone capture, routed through the best available pipeline. This hook is
 * only the React adapter: it feature-detects support after hydration, reads the
 * server's advertised capabilities, mirrors the active session's state into
 * React state, and owns exactly one session per capture.
 *
 * When the server advertises a streaming provider, audio is captured with
 * `getUserMedia` and sent to the server (browser-independent, consistent across
 * Chrome/Brave/Firefox). Otherwise it falls back to the browser's own `Web
 * Speech API` — honestly, with its known per-browser limits — or reports that
 * no pipeline exists so the text composer remains the answer.
 *
 * The session is created on demand and disposed on mic-off and unmount, so a
 * remount (Strict Mode, Fast Refresh, hydration recovery) always gets a fresh
 * session that still reports results.
 */
export function useSpeechCapture({
  language,
  onFinalText,
  onInterimEmit,
  onNotice,
  getSocket,
}: SpeechCaptureOptions): SpeechCapture {
  const browserSupport = useSyncExternalStore(
    subscribeToNothing,
    readBrowserSupport,
    readSupportOnServer,
  );
  const capabilities = useSyncExternalStore(
    subscribeSpeechCapabilities,
    getSpeechCapabilities,
    getServerSpeechCapabilities,
  );

  const [capturing, setCapturing] = useState(false);
  const [permission, setPermission] = useState<MicPermission>("prompt");
  const [status, setStatus] = useState<RecognitionStatus>("idle");
  const [error, setError] = useState<SpeechError | null>(null);
  const [interim, setInterim] = useState("");
  // The transport a live capture is actually using, so a late capability frame
  // cannot relabel a session that is already running.
  const [activeTransport, setActiveTransport] =
    useState<SpeechTransport | null>(null);

  const sessionRef = useRef<ActiveCapture | null>(null);
  const languageRef = useRef(language);
  const getSocketRef = useRef(getSocket);
  const onFinalRef = useRef(onFinalText);
  const onInterimEmitRef = useRef(onInterimEmit);
  const onNoticeRef = useRef(onNotice);

  useEffect(() => {
    getSocketRef.current = getSocket;
    onFinalRef.current = onFinalText;
    onInterimEmitRef.current = onInterimEmit;
    onNoticeRef.current = onNotice;
  }, [getSocket, onFinalText, onInterimEmit, onNotice]);

  const browserReady = browserSupport === "supported";
  const serverReady =
    capabilities !== null &&
    capabilities.provider !== "none" &&
    capabilities.streaming &&
    isMicCaptureSupported();
  const availableTransport = selectTransport({
    preference: env.speechProvider,
    browserReady,
    serverReady,
  });
  const support: SpeechSupport =
    browserSupport === "checking"
      ? "checking"
      : availableTransport === "none"
        ? "unsupported"
        : "supported";

  /** Stable event plumbing: every callback reads the current ref. */
  const eventsRef = useRef({
    onStatus: (next: RecognitionStatus) => setStatus(next),
    onCapturing: (next: boolean) => {
      setCapturing(next);
      // Capture is over (stopped or failed): forget the live transport so the
      // next start re-reads whatever pipeline is available then.
      if (!next) setActiveTransport(null);
    },
    onPermission: (next: MicPermission) => setPermission(next),
    onError: (next: SpeechError | null) => setError(next),
    onNotice: (message: string) => onNoticeRef.current?.(message),
    onInterim: (text: string) => setInterim(text),
    onEmitInterim: (text: string) => onInterimEmitRef.current(text),
    onFinal: (text: string) => onFinalRef.current(text),
  } satisfies CaptureEvents);

  /** The controller for a transport, reused until the transport changes. */
  const controllerFor = useCallback(
    (transport: SpeechTransport): CaptureController => {
      const existing = sessionRef.current;
      if (existing && existing.transport === transport)
        return existing.controller;
      existing?.controller.dispose();
      const controller: CaptureController =
        transport === "server"
          ? new ServerCaptureSession({
              language: languageRef.current,
              events: eventsRef.current,
              describeLanguage: languageLabel,
              getSocket: () => getSocketRef.current?.() ?? null,
            })
          : new CaptureSession({
              language: languageRef.current,
              events: eventsRef.current,
              describeLanguage: languageLabel,
            });
      sessionRef.current = { transport, controller };
      return controller;
    },
    [],
  );

  const handleToggle = useCallback(() => {
    const active = sessionRef.current;
    if (active?.controller.running) {
      active.controller.stop();
      return;
    }
    if (availableTransport === "none") {
      const failure = unavailableError(env.speechProvider);
      setError(failure);
      onNoticeRef.current?.(failure.message);
      return;
    }
    setActiveTransport(availableTransport);
    controllerFor(availableTransport).start();
  }, [availableTransport, controllerFor]);

  const handleStop = useCallback(() => {
    sessionRef.current?.controller.stop();
  }, []);

  // Unmount releases the session outright: aborted, timers cleared, and every
  // late callback muted by the session's own disposed flag.
  useEffect(() => {
    return () => {
      sessionRef.current?.controller.dispose();
      sessionRef.current = null;
    };
  }, []);

  // Switching the speaking language follows the new locale. Only the browser
  // session can retarget a live run; the server session applies it next start.
  useEffect(() => {
    languageRef.current = language;
    sessionRef.current?.controller.setLanguage(language);
  }, [language]);

  // A live capture always reports the transport it is actually using, even if
  // capabilities arrive late and change which pipeline a *new* capture would
  // pick.
  const transport = activeTransport ?? availableTransport;

  return {
    support,
    transport,
    capturing,
    permission,
    status,
    error,
    interim,
    toggle: handleToggle,
    stop: handleStop,
  };
}
