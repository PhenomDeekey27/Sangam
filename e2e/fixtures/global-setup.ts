/**
 * Playwright global setup: materialise the fake-microphone WAV before any
 * browser is launched (the file path is passed to Chromium as a launch arg).
 */
import path from "node:path";
import { E2E } from "../e2e-config";
import { writeSpeechFixture } from "./generate-audio";

export default function globalSetup(): void {
  writeSpeechFixture(path.resolve(process.cwd(), E2E.speechFixture));
}
