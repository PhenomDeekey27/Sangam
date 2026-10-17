/**
 * Shared, non-secret endpoints for the Playwright interruption suite.
 *
 * The automated run never talks to a real vendor. It boots the real Sangam
 * server with the deterministic mock speech provider from `server/src` plus
 * scripted translation/TTS doubles (see `e2e/server/backend.ts`), so no API key
 * is ever read, sent, or logged and no paid request is made.
 */
export const E2E = {
  appPort: 3100,
  socketPort: 4400,
  controlPort: 4401,
  appOrigin: "http://127.0.0.1:3100",
  socketUrl: "http://127.0.0.1:4400",
  controlUrl: "http://127.0.0.1:4401",
  /** Throwaway Next build dir for the suite's own dev server (see next.config.ts). */
  distDir: ".next/e2e",
  /** Deterministic fake-microphone fixture, generated before browsers launch. */
  speechFixture: "e2e/fixtures/speech.wav",
} as const;
