import path from "node:path";
import { defineConfig } from "@playwright/test";
import { E2E } from "./e2e/e2e-config";

/**
 * Playwright configuration for the two-browser interruption suite.
 *
 * Two web servers are started: the real Sangam Socket.IO backend wired with
 * deterministic doubles (`e2e/server/backend.ts`) and the real Next.js app
 * pointed at that backend. Chromium is launched with the fake-media flags so a
 * WAV fixture is presented to the app as a live microphone, and audio playback
 * is muted (the DOM still reports the real start/stop/ended lifecycle).
 */
const rootDir = process.cwd();
const speechFixture = path.resolve(rootDir, E2E.speechFixture);

export default defineConfig({
  testDir: "./e2e/tests",
  globalSetup: "./e2e/fixtures/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: E2E.appOrigin,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-audio-capture=${speechFixture}`,
        "--autoplay-policy=no-user-gesture-required",
        "--mute-audio",
      ],
    },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: [
    {
      command: "node --import tsx e2e/server/backend.ts",
      url: `${E2E.socketUrl}/health`,
      cwd: rootDir,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...process.env,
        E2E_SOCKET_PORT: String(E2E.socketPort),
        E2E_CONTROL_PORT: String(E2E.controlPort),
        E2E_APP_ORIGIN: E2E.appOrigin,
      },
    },
    {
      command: `npx next dev --port ${E2E.appPort} --hostname 127.0.0.1`,
      url: E2E.appOrigin,
      cwd: rootDir,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        ...process.env,
        NEXT_PUBLIC_SOCKET_URL: E2E.socketUrl,
        // Isolate this dev server's build output (and its exclusive dev lock)
        // from any `next dev` the developer already has running.
        SANGAM_DIST_DIR: E2E.distDir,
      },
    },
  ],
});
