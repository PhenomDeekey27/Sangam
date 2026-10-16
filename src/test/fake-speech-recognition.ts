/**
 * Controllable `SpeechRecognition` double for tests. It implements the same
 * structural interface the browser adapter depends on, so any drift between
 * the fake and `SpeechRecognitionLike` fails typecheck rather than silently
 * passing tests.
 */
import type {
  SpeechRecognitionErrorEventLike,
  SpeechRecognitionEventLike,
  SpeechRecognitionLike,
} from "@/features/speech/services/web-speech";

/** One recognition session the app created, plus its scripted outcomes. */
export class FakeSession implements SpeechRecognitionLike {
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onstart: ((event: Event) => void) | null = null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null = null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null = null;
  onend: ((event: Event) => void) | null = null;

  /** How many times each lifecycle method was called. */
  starts = 0;
  stops = 0;
  aborts = 0;
  /** When set, `start()` throws this value instead of emitting `onstart`. */
  startError: unknown = null;
  /** When true, `start()` records the call but never emits `onstart`. */
  silentStart = false;

  start(): void {
    this.starts += 1;
    if (this.startError !== null) throw this.startError;
    if (this.silentStart) return;
    queueMicrotask(() => this.onstart?.(new Event("start")));
  }

  stop(): void {
    this.stops += 1;
    queueMicrotask(() => this.onend?.(new Event("end")));
  }

  abort(): void {
    this.aborts += 1;
    queueMicrotask(() => this.onend?.(new Event("end")));
  }

  /** Emit one recognition result; mirrors the real event's shape. */
  emitResult(text: string, isFinal: boolean, resultIndex = 0): void {
    const results = {
      length: resultIndex + 1,
      [resultIndex]: { isFinal, 0: { transcript: text } },
    } as unknown as SpeechRecognitionEventLike["results"];
    this.onresult?.({ resultIndex, results });
  }

  emitError(error: string): void {
    this.onerror?.({ error });
  }

  emitEnd(): void {
    this.onend?.(new Event("end"));
  }
}

/**
 * Registry shared by every fake the app constructs while installed. A module
 * level object (rather than instance state) keeps the installed constructor
 * free of a `this` alias.
 */
const registry = {
  sessions: [] as FakeSession[],
  silentByDefault: false,
  nextStartError: null as unknown,
};

/** Installable fake constructor bound to a jsdom-like window. */
export class FakeSpeechRecognition {
  /** Every session the app created while the fake was installed. */
  get sessions(): FakeSession[] {
    return registry.sessions;
  }

  /** Every session created from now on starts without reporting `onstart`. */
  set silentByDefault(silent: boolean) {
    registry.silentByDefault = silent;
  }

  /** One-shot: the next created session throws this from `start()`. */
  set nextStartError(error: unknown) {
    registry.nextStartError = error;
  }

  private previous: {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  } = {};

  /** Last session the app created (the one currently in charge). */
  current(): FakeSession {
    const session = registry.sessions.at(-1);
    if (!session) throw new Error("no recognition session was created");
    return session;
  }

  install(): void {
    const scope = window as unknown as Record<string, unknown>;
    this.previous = {
      SpeechRecognition: scope.SpeechRecognition,
      webkitSpeechRecognition: scope.webkitSpeechRecognition,
    };
    registry.sessions = [];
    registry.silentByDefault = false;
    registry.nextStartError = null;

    /* A real class: the browser adapter constructs sessions with `new`. */
    class InstalledFake extends FakeSession {
      constructor() {
        super();
        registry.sessions.push(this);
        this.silentStart = registry.silentByDefault;
        if (registry.nextStartError !== null) {
          this.startError = registry.nextStartError;
          registry.nextStartError = null;
        }
      }
    }
    scope.SpeechRecognition = InstalledFake;
    scope.webkitSpeechRecognition = InstalledFake;
  }

  uninstall(): void {
    const scope = window as unknown as Record<string, unknown>;
    scope.SpeechRecognition = this.previous.SpeechRecognition;
    scope.webkitSpeechRecognition = this.previous.webkitSpeechRecognition;
    registry.sessions = [];
    registry.silentByDefault = false;
    registry.nextStartError = null;
  }
}
