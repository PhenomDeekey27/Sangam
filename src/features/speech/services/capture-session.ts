/**
 * Microphone capture policy, free of React.
 *
 * One `CaptureSession` owns exactly one live `SpeechRecognition` at a time and
 * decides when to restart, throttle, deduplicate, or give up. A session is
 * created on demand and `dispose()`d on mic-off or unmount; a superseded or
 * disposed session ignores late callbacks, so no result is swallowed by a
 * stale "mounted" flag.
 */
import {
  errorForStartFailure,
  microphoneNeverStartedError,
  recognitionKeptStoppingError,
} from "@/features/speech/services/capture-errors";
import {
  createBrowserRecognition,
  type BrowserRecognition,
} from "@/features/speech/services/web-speech";
import type {
  CaptureController,
  MicPermission,
  RecognitionStatus,
  SpeechError,
} from "@/features/speech/types";

/** Minimum gap between interim emissions over the socket. */
export const INTERIM_EMIT_MIN_MS = 250;
/** Pause before an automatic restart after an unexpected recognition end. */
export const RESTART_DELAY_MS = 300;
/** A final identical to the previous one within this window is dropped. */
export const DUPLICATE_FINAL_WINDOW_MS = 2000;
/** Consecutive runs that end before any result before capture gives up. */
export const MAX_RUNS_WITHOUT_RESULT = 3;
/** How long a graceful stop keeps draining the in-flight phrase. */
export const STOP_DRAIN_MS = 1500;
/** How long a session may stay silent before it is retried, then reported. */
export const START_WATCHDOG_MS = 10_000;

/** Everything a session reports back to its owner. */
export interface CaptureEvents {
  readonly onStatus: (status: RecognitionStatus) => void;
  /** The user has capture on: mirrors start/stop/fail on the mic button. */
  readonly onCapturing: (capturing: boolean) => void;
  readonly onPermission: (permission: MicPermission) => void;
  readonly onError: (error: SpeechError | null) => void;
  readonly onNotice: (message: string) => void;
  /** Local interim text, updated on every result (not throttled). */
  readonly onInterim: (text: string) => void;
  /** Interim text to relay to the partner, throttled; `""` clears the line. */
  readonly onEmitInterim: (text: string) => void;
  readonly onFinal: (text: string) => void;
}

/**
 * Options for one browser recognition session.
 */
export interface CaptureSessionOptions {
  readonly language: string;
  readonly events: CaptureEvents;
  /** Session factory override; defaults to the Web Speech adapter. */
  readonly createSession?: typeof createBrowserRecognition;
  /** Human-readable language name for user-facing notices. */
  readonly describeLanguage?: (code: string) => string;
  /** Timing knobs, defaulted for real browsers and shortened in tests. */
  readonly interimEmitMinMs?: number;
  readonly restartDelayMs?: number;
  readonly duplicateFinalWindowMs?: number;
  readonly maxRunsWithoutResult?: number;
  readonly stopDrainMs?: number;
  readonly startWatchdogMs?: number;
}

export class CaptureSession implements CaptureController {
  private readonly events: CaptureEvents;
  private readonly createSession: typeof createBrowserRecognition;
  private readonly describeLanguage: (code: string) => string;
  private readonly interimEmitMinMs: number;
  private readonly restartDelayMs: number;
  private readonly duplicateFinalWindowMs: number;
  private readonly maxRunsWithoutResult: number;
  private readonly stopDrainMs: number;
  private readonly startWatchdogMs: number;

  private language: string;
  private recognition: BrowserRecognition | null = null;
  /**
   * Identity of the session in charge. Browsers deliver `end` for a session we
   * already replaced (retry, language switch, failure); acting on it would
   * restart capture or wipe an error, so superseded callbacks are dropped.
   */
  private generation = 0;
  private disposed = false;
  private desired = false;
  private started = false;
  private resultSeen = false;
  private failedRuns = 0;
  private watchdogRetries = 0;
  private sessionNotified = false;
  private lastFinal: { text: string; at: number } | null = null;
  private drainDeadline = 0;
  private restartTimer: number | null = null;
  private stopTimer: number | null = null;
  private watchdogTimer: number | null = null;
  private interim = {
    lastAt: 0,
    lastText: "",
    pending: "",
    timer: null as number | null,
  };

  constructor(options: CaptureSessionOptions) {
    this.events = options.events;
    this.createSession = options.createSession ?? createBrowserRecognition;
    this.describeLanguage = options.describeLanguage ?? ((code) => code);
    this.interimEmitMinMs = options.interimEmitMinMs ?? INTERIM_EMIT_MIN_MS;
    this.restartDelayMs = options.restartDelayMs ?? RESTART_DELAY_MS;
    this.duplicateFinalWindowMs =
      options.duplicateFinalWindowMs ?? DUPLICATE_FINAL_WINDOW_MS;
    this.maxRunsWithoutResult =
      options.maxRunsWithoutResult ?? MAX_RUNS_WITHOUT_RESULT;
    this.stopDrainMs = options.stopDrainMs ?? STOP_DRAIN_MS;
    this.startWatchdogMs = options.startWatchdogMs ?? START_WATCHDOG_MS;
    this.language = options.language;
  }

  /** True while capture is wanted (starting, listening, draining). */
  get running(): boolean {
    return this.desired;
  }

  /** Begin capturing: real browsers only grant the microphone from a gesture. */
  start(): void {
    if (this.disposed || this.desired) return;
    this.desired = true;
    this.sessionNotified = false;
    this.failedRuns = 0;
    this.watchdogRetries = 0;
    this.resultSeen = false;
    this.events.onCapturing(true);
    this.events.onError(null);
    this.events.onStatus("starting");
    this.events.onNotice("Starting the microphone…");
    this.beginSession();
  }

  /** Stop capturing gracefully; the in-flight phrase may still finalize. */
  stop(): void {
    if (!this.desired && this.recognition === null) return;
    this.desired = false;
    this.drainDeadline = Date.now() + this.stopDrainMs;
    this.clearTimers();
    this.clearInterim();
    this.events.onNotice("Microphone off.");
    const session = this.recognition;
    if (!session) {
      this.finishStopped();
      return;
    }
    this.events.onStatus("stopping");
    try {
      session.stop();
    } catch {
      this.abortSession();
      this.finishStopped();
      return;
    }
    // Safety net: some browsers never emit `end` after stop().
    this.stopTimer = this.setTimer(() => {
      this.stopTimer = null;
      if (this.desired || this.disposed) return;
      this.abortSession();
      this.finishStopped();
    }, this.stopDrainMs + 500);
  }

  /** Release everything: no callback fires after this returns. */
  dispose(): void {
    this.disposed = true;
    this.desired = false;
    this.clearTimers();
    this.abortSession();
  }

  /** Follow a new speaking language, restarting a live session. */
  setLanguage(language: string): void {
    const changed = language !== this.language;
    this.language = language;
    if (!changed || !this.desired || this.disposed) return;
    this.abortSession();
    this.beginSession();
  }

  private beginSession(): void {
    if (this.disposed) return;
    this.started = false;
    const generation = (this.generation += 1);
    const current = () => generation === this.generation && !this.disposed;
    try {
      const session = this.createSession(this.language, {
        onStart: () => {
          if (current()) this.handleStart();
        },
        onInterim: (text) => {
          if (current()) this.handleInterim(text);
        },
        onFinal: (text) => {
          if (current()) this.handleFinal(text);
        },
        onError: (failure) => {
          if (current()) this.handleError(failure);
        },
        onEnd: () => {
          if (current()) this.handleEnd();
        },
      });
      this.recognition = session;
      session.start();
    } catch (cause) {
      const failure = errorForStartFailure(cause);
      this.fail(failure.error, failure.permissionDenied);
      return;
    }
    // A session that never reports `onstart` would leave the UI "starting"
    // forever: retry it once, then report it plainly.
    this.watchdogTimer = this.setTimer(() => {
      this.watchdogTimer = null;
      if (this.disposed || !this.desired || this.started) return;
      if (this.watchdogRetries === 0) {
        this.watchdogRetries += 1;
        this.abortSession();
        this.beginSession();
        return;
      }
      this.fail(microphoneNeverStartedError, false);
    }, this.startWatchdogMs);
  }

  private handleStart(): void {
    if (this.disposed || !this.desired) return;
    this.started = true;
    this.watchdogRetries = 0;
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.events.onPermission("granted");
    this.events.onStatus("listening");
    if (!this.sessionNotified) {
      this.sessionNotified = true;
      this.events.onNotice(
        `Microphone on — speak in ${this.describeLanguage(this.language)}. Interim words appear live; finished sentences join the transcript.`,
      );
    }
  }

  private handleInterim(text: string): void {
    if (this.disposed || !this.acceptingResults()) return;
    this.resultSeen = true;
    this.events.onInterim(text);
    this.interim.pending = text;
    const elapsed = Date.now() - this.interim.lastAt;
    if (elapsed >= this.interimEmitMinMs) {
      if (this.interim.timer !== null) {
        clearTimeout(this.interim.timer);
        this.interim.timer = null;
      }
      this.emitInterimNow(text);
      return;
    }
    if (this.interim.timer === null) {
      this.interim.timer = this.setTimer(() => {
        this.interim.timer = null;
        this.emitInterimNow(this.interim.pending);
      }, this.interimEmitMinMs - elapsed);
    }
  }

  private handleFinal(text: string): void {
    if (this.disposed || !this.acceptingResults()) return;
    this.resultSeen = true;
    const now = Date.now();
    const previous = this.lastFinal;
    const duplicate =
      previous !== null &&
      previous.text === text &&
      now - previous.at < this.duplicateFinalWindowMs;
    this.lastFinal = { text, at: now };
    this.clearInterim();
    if (duplicate) return;
    this.events.onFinal(text);
  }

  private handleError(failure: SpeechError): void {
    if (this.disposed || !this.desired) return;
    if (failure.code === "aborted") return;
    if (failure.code === "no_speech") {
      // A silence timeout, not a failure: the session auto-restarts.
      this.events.onNotice(failure.message);
      return;
    }
    this.fail(failure, failure.code === "permission_denied");
  }

  private handleEnd(): void {
    // `recognition` is null once this session already ended or was discarded.
    if (this.disposed || this.recognition === null) return;
    this.recognition = null;
    if (!this.desired) {
      this.clearTimers();
      this.clearInterim();
      this.finishStopped();
      return;
    }
    if (!this.resultSeen) {
      this.failedRuns += 1;
      if (this.failedRuns >= this.maxRunsWithoutResult) {
        this.fail(recognitionKeptStoppingError, false);
        return;
      }
    } else {
      this.failedRuns = 0;
    }
    this.resultSeen = false;
    this.clearTimers();
    this.restartTimer = this.setTimer(() => {
      this.restartTimer = null;
      if (this.disposed || !this.desired) return;
      this.beginSession();
    }, this.restartDelayMs);
  }

  /** Give up on capture, telling the user why. */
  private fail(failure: SpeechError, permissionHit: boolean): void {
    this.desired = false;
    this.clearTimers();
    this.abortSession();
    this.clearInterim();
    if (this.disposed) return;
    if (permissionHit) this.events.onPermission("denied");
    this.events.onError(failure);
    this.events.onStatus("error");
    this.events.onCapturing(false);
    this.events.onNotice(failure.message);
  }

  /** Capture is fully stopped: idle, and the mic button is off. */
  private finishStopped(): void {
    this.events.onStatus("idle");
    this.events.onCapturing(false);
  }

  private acceptingResults(): boolean {
    return this.desired || Date.now() < this.drainDeadline;
  }

  private emitInterimNow(text: string): void {
    this.interim.lastText = text;
    this.interim.lastAt = Date.now();
    this.events.onEmitInterim(text);
  }

  /** Clear the interim line locally and tell the partner to clear theirs. */
  private clearInterim(): void {
    if (this.interim.timer !== null) {
      clearTimeout(this.interim.timer);
      this.interim.timer = null;
    }
    this.interim.pending = "";
    // `dispose()` sets `disposed` first, so a disposed session stays silent.
    if (!this.disposed) this.events.onInterim("");
    if (this.interim.lastText !== "") this.emitInterimNow("");
  }

  private abortSession(): void {
    const session = this.recognition;
    this.recognition = null;
    // Supersede the discarded session so its closing `end` cannot act.
    this.generation += 1;
    try {
      session?.abort();
    } catch {
      /* already finished */
    }
  }

  private clearTimers(): void {
    for (const key of ["restartTimer", "stopTimer", "watchdogTimer"] as const) {
      const timer = this[key];
      if (timer !== null) {
        clearTimeout(timer);
        this[key] = null;
      }
    }
  }

  private setTimer(callback: () => void, ms: number): number {
    // The ambient timer (not `window`'s) so tests can drive it directly.
    return setTimeout(callback, ms) as unknown as number;
  }
}
