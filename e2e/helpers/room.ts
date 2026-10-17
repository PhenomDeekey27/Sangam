/**
 * Two-participant room helpers for the Playwright interruption suite.
 *
 * A `Participant` owns one isolated browser context (cookies, permissions, and
 * a fresh Socket.IO connection), attaches the frame/console diagnostics before
 * the first navigation, and exposes only the real user-facing controls the
 * suite is allowed to drive: the text composer, the single playback control,
 * and the interrupt button. Nothing here reaches into app internals.
 */
import {
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { E2E } from "../e2e-config";
import { attachDiagnostics, type Diagnostics } from "./diagnostics";
import { speechSpyInitScript } from "./speech-spy";

/** Room-code alphabet matches the app: no ambiguous 0/O/1/I/L. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Deterministic six-character room code derived from a seed. Each test uses a
 * distinct seed, so rooms never collide inside one server run while the code
 * stays reproducible between runs.
 */
export function roomCode(seed: string): string {
  let a = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    a = Math.imul(a ^ seed.charCodeAt(i), 0x01000193);
  }
  let b = 0x9e3779b9 ^ a;
  for (let i = 0; i < seed.length; i += 1) {
    b = Math.imul(b ^ seed.charCodeAt(i), 0x85ebca6b);
  }
  const chars: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const value = i % 2 === 0 ? a >>> (i * 4) : b >>> (i * 4);
    chars.push(ALPHABET[value % ALPHABET.length]);
  }
  return chars.join("");
}

export interface LanguagePreferences {
  readonly speak: string;
  readonly hear: string;
}

/** Direct-join room URL carrying both language preferences. */
export function roomUrl(
  code: string,
  prefs: LanguagePreferences,
  options: { create?: boolean } = {},
): string {
  const params = new URLSearchParams({ speak: prefs.speak, hear: prefs.hear });
  if (options.create) params.set("create", "1");
  return `${E2E.appOrigin}/room/${code}?${params.toString()}`;
}

export interface EnterRoomOptions extends LanguagePreferences {
  readonly code: string;
  readonly create?: boolean;
}

export interface Participant {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly diag: Diagnostics;
  /** Navigate and wait until this seat is seated and can send text. */
  enter(options: EnterRoomOptions): Promise<void>;
  /** Wait until the other seat is present (the interrupt button unlocks). */
  waitForPartner(): Promise<void>;
  /** Type a message in the composer and send it. */
  send(text: string): Promise<void>;
  /** Supply the user gesture that lets the browser start audio. */
  enablePlayback(): Promise<void>;
  /** Press the real interrupt control. */
  interrupt(): Promise<void>;
  /** Stable handle on the interrupt button across its label changes. */
  readonly interruptControl: Locator;
  /** Current interrupt button copy ("Interrupt", "Interrupted", …). */
  interruptLabel(): Promise<string>;
  readonly playbackButton: Locator;
  readonly interruptButton: Locator;
  close(): Promise<void>;
}

export interface OpenParticipantOptions {
  /**
   * Install the deterministic `speechSynthesis` recorder before the app loads
   * (used by the browser-fallback scenario).
   */
  readonly speechSpy?: boolean;
}

export async function openParticipant(
  browser: Browser,
  options: OpenParticipantOptions = {},
): Promise<Participant> {
  const context = await browser.newContext({ permissions: ["microphone"] });
  if (options.speechSpy) await context.addInitScript(speechSpyInitScript);
  const page = await context.newPage();
  const diag = attachDiagnostics(page);
  const interruptButton = page.getByRole("button", {
    name: "Interrupt",
    exact: true,
  });
  const interruptControl = page.locator("button", { hasText: /interrupt/i });
  const playbackButton = page.locator("button[data-action]").first();

  return {
    context,
    page,
    diag,
    playbackButton,
    interruptButton,
    interruptControl,
    async interruptLabel() {
      return (await interruptControl.innerText()).trim();
    },
    async enter({ code, speak, hear, create }) {
      await page.goto(roomUrl(code, { speak, hear }, { create }));
      await expect(page.locator("#composer-input")).toBeEnabled({
        timeout: 30_000,
      });
    },
    async waitForPartner() {
      await expect(interruptButton).toBeEnabled({ timeout: 20_000 });
    },
    async send(text) {
      const input = page.locator("#composer-input");
      await input.fill(text);
      await page.getByRole("button", { name: "Send typed message" }).click();
    },
    async enablePlayback() {
      if (await playbackButton.isVisible()) await playbackButton.click();
    },
    async interrupt() {
      await interruptButton.click();
    },
    async close() {
      await context.close();
    },
  };
}

export interface TtsCall {
  readonly text: string;
  readonly language: string;
  readonly atMs: number;
}

export interface TranslationCall {
  readonly text: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
}

export interface ControlState {
  readonly tts: {
    readonly mode: string;
    readonly durationMs: number;
    readonly pending: number;
    readonly calls: readonly TtsCall[];
  };
  readonly translator: { readonly calls: readonly TranslationCall[] };
}

export type TtsMode = "immediate" | "deferred" | "fail" | "fail-deferred";

/** Client for the E2E backend's localhost-only control server. */
export interface ControlClient {
  reset(): Promise<void>;
  configureTts(next: { mode?: TtsMode; durationMs?: number }): Promise<void>;
  release(): Promise<number>;
  state(): Promise<ControlState>;
  /** Wait (bounded) until this many syntheses are held in flight. */
  waitForTtsPending(count: number): Promise<void>;
  /** Wait (bounded) until this many translations have been requested. */
  waitForTranslations(count: number): Promise<void>;
}

async function post(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${E2E.controlUrl}${path}`, { method: "POST" });
  return (await response.json()) as Record<string, unknown>;
}

async function readState(): Promise<ControlState> {
  const response = await fetch(`${E2E.controlUrl}/state`);
  return (await response.json()) as ControlState;
}

async function pollUntil(
  label: string,
  ready: (state: ControlState) => boolean,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: ControlState | null = null;
  while (Date.now() < deadline) {
    last = await readState();
    if (ready(last)) return;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(
    `timed out waiting for ${label}; last state: ${JSON.stringify(last)}`,
  );
}

export function controlClient(): ControlClient {
  return {
    async reset() {
      await post("/reset");
    },
    async configureTts(next) {
      const response = await fetch(`${E2E.controlUrl}/tts/configure`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!response.ok)
        throw new Error(`tts configure failed: ${response.status}`);
    },
    async release() {
      const body = await post("/tts/release");
      return typeof body.released === "number" ? body.released : 0;
    },
    state: readState,
    waitForTtsPending: (count) =>
      pollUntil(
        `tts.pending === ${count}`,
        (state) => state.tts.pending === count,
      ),
    waitForTranslations: (count) =>
      pollUntil(
        `translator.calls === ${count}`,
        (state) => state.translator.calls.length === count,
      ),
  };
}
