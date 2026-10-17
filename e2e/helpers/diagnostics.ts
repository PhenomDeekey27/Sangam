/**
 * Browser-side capture for the interruption suite.
 *
 * Two independent streams are observed, both event-driven (no polling sleeps):
 * - `sangam`: the app's own development diagnostics written to `console.debug`
 *   (`[sangam] playback|latency|translate|speech …`). They are derived from the
 *   real socket deliveries and playback queue, and name the utterance id and
 *   `sequence`, which is exactly what correlation needs.
 * - `socket`: the real Socket.IO frames on the page's WebSocket, decoded from
 *   the engine.io text frames. Binary playback attachments are recorded as
 *   markers; their metadata travels in the preceding text frame.
 *
 * Console `error`s and uncaught page errors are collected so a test can assert
 * the run was clean. Nothing captures transcript text into a file or log.
 */
import { expect, type Page } from "@playwright/test";

export interface WaitOptions {
  readonly timeoutMs?: number;
  readonly label?: string;
}

interface Waiter<T> {
  readonly predicate: (item: T) => boolean;
  readonly resolve: (item: T) => void;
  readonly reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** An append-only stream that resolves waiters the moment a match arrives. */
export class Recorder<T> {
  readonly items: T[] = [];
  private readonly waiters = new Set<Waiter<T>>();

  push(item: T): void {
    this.items.push(item);
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(item)) continue;
      this.waiters.delete(waiter);
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(item);
    }
  }

  reset(): void {
    this.items.length = 0;
  }

  waitFor(
    predicate: (item: T) => boolean,
    { timeoutMs = 20_000, label = "record" }: WaitOptions = {},
  ): Promise<T> {
    const existing = this.items.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter<T> = {
        predicate,
        resolve,
        reject,
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(
          new Error(
            `timed out after ${timeoutMs}ms waiting for ${label}; saw: ` +
              this.items
                .slice(-6)
                .map((item) => JSON.stringify(item))
                .join(" | "),
          ),
        );
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }
}

export type SangamKind =
  "playback" | "latency" | "translate" | "speech" | "other";

export interface SangamRecord {
  readonly kind: SangamKind;
  readonly raw: string;
  readonly stage?: string;
  readonly utteranceId?: string;
  readonly sequence?: number;
  readonly status?: string;
  readonly reason?: string;
  readonly outcome?: string;
  readonly language?: string;
}

export interface SocketRecord {
  readonly direction: "in" | "out";
  readonly event: string;
  readonly data: unknown;
  readonly binary: boolean;
  readonly raw: string;
}

export interface Diagnostics {
  readonly sangam: Recorder<SangamRecord>;
  readonly socket: Recorder<SocketRecord>;
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
  /** Assert the page produced no uncaught error and no unexpected console error. */
  expectClean(): void;
  /** Playback diagnostics for one utterance id, in arrival order. */
  playbackFor(utteranceId: string): SangamRecord[];
}

function toKind(token: string): SangamKind {
  if (token === "playback") return "playback";
  if (token === "latency") return "latency";
  if (token === "translate") return "translate";
  if (token === "speech") return "speech";
  return "other";
}

function numberAfter(text: string, key: string): number | undefined {
  const match = new RegExp(`${key}=(-?\\d+)`).exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/** Parse one `[sangam] …` development diagnostic line, or `null`. */
export function parseSangamLine(text: string): SangamRecord | null {
  if (!text.startsWith("[sangam]")) return null;
  const body = text.slice("[sangam]".length).trim();
  const tokens = body.split(/\s+/);
  const kind = toKind(tokens[0] ?? "");
  let utteranceId = /utterance=(\S+)/.exec(body)?.[1];
  if (!utteranceId && (kind === "latency" || kind === "translate")) {
    utteranceId = tokens[1];
  }
  if (!utteranceId && kind === "speech" && tokens[1] === "final") {
    utteranceId = tokens[2];
  }
  return {
    kind,
    raw: text,
    stage: /stage=(\S+)/.exec(body)?.[1],
    utteranceId,
    sequence: numberAfter(body, "sequence"),
    status: /status=(\S+)/.exec(body)?.[1],
    reason: /reason=(\S+)/.exec(body)?.[1],
    outcome: /outcome=(\S+)/.exec(body)?.[1],
    language: /lang=(\S+)/.exec(body)?.[1],
  };
}

/** Decode an engine.io/Socket.IO text frame into its event + payload. */
export function parseSocketFrame(
  payload: string | Buffer,
  direction: "in" | "out",
): SocketRecord | null {
  if (typeof payload !== "string") {
    return {
      direction,
      event: "binary",
      data: null,
      binary: true,
      raw: `<binary ${payload.length}b>`,
    };
  }
  const start = payload.indexOf("[");
  if (start === -1) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.slice(start));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || typeof parsed[0] !== "string") return null;
  const event = parsed[0] as string;
  // Socket.IO control events (`connect`, `disconnect`, …) are noise here.
  if (["connect", "disconnect", "connect_error"].includes(event)) return null;
  return {
    direction,
    event,
    data: parsed[1] ?? null,
    binary: false,
    raw: payload,
  };
}

/** Console errors that are environmental noise, not the app failing. */
const BENIGN_CONSOLE = [
  "favicon",
  "Download the React DevTools",
  "Failed to load resource",
];

export function attachDiagnostics(page: Page): Diagnostics {
  const sangam = new Recorder<SangamRecord>();
  const socket = new Recorder<SocketRecord>();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (message) => {
    const text = message.text();
    const record = parseSangamLine(text);
    if (record) sangam.push(record);
    if (message.type() === "error") consoleErrors.push(text);
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("websocket", (webSocket) => {
    webSocket.on("framereceived", (frame) => {
      const record = parseSocketFrame(frame.payload as string | Buffer, "in");
      if (record) socket.push(record);
    });
    webSocket.on("framesent", (frame) => {
      const record = parseSocketFrame(frame.payload as string | Buffer, "out");
      if (record) socket.push(record);
    });
  });

  return {
    sangam,
    socket,
    consoleErrors,
    pageErrors,
    playbackFor(utteranceId) {
      return sangam.items.filter(
        (record) =>
          record.kind === "playback" && record.utteranceId === utteranceId,
      );
    },
    expectClean() {
      const unexpected = consoleErrors.filter(
        (text) => !BENIGN_CONSOLE.some((benign) => text.includes(benign)),
      );
      expect(
        pageErrors,
        `uncaught page errors: ${pageErrors.join(" | ")}`,
      ).toEqual([]);
      expect(
        unexpected,
        `unexpected console errors: ${unexpected.join(" | ")}`,
      ).toEqual([]);
    },
  };
}
