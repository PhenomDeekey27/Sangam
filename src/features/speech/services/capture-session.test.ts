import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { SpeechError } from "@/features/speech/types";
import {
  CaptureSession,
  type CaptureEvents,
  type CaptureSessionOptions,
} from "@/features/speech/services/capture-session";
import { FakeSpeechRecognition } from "@/test/fake-speech-recognition";

/**
 * The session drives the real Web Speech adapter, so results are produced
 * through `FakeSpeechRecognition` (installed as the browser's implementation)
 * rather than by re-implementing the adapter's event handling here.
 */
const fake = new FakeSpeechRecognition();

interface Observed {
  readonly statuses: string[];
  readonly capturing: boolean[];
  readonly permissions: string[];
  readonly errors: (SpeechError | null)[];
  readonly notices: string[];
  readonly localInterims: string[];
  readonly emittedInterims: string[];
  readonly finals: string[];
}

function build(overrides: Partial<CaptureSessionOptions> = {}) {
  const observed: Observed = {
    statuses: [],
    capturing: [],
    permissions: [],
    errors: [],
    notices: [],
    localInterims: [],
    emittedInterims: [],
    finals: [],
  };
  const events: CaptureEvents = {
    onStatus: (status) => observed.statuses.push(status),
    onCapturing: (capturing) => observed.capturing.push(capturing),
    onPermission: (permission) => observed.permissions.push(permission),
    onError: (error) => observed.errors.push(error),
    onNotice: (message) => observed.notices.push(message),
    onInterim: (text) => observed.localInterims.push(text),
    onEmitInterim: (text) => observed.emittedInterims.push(text),
    onFinal: (text) => observed.finals.push(text),
  };
  const session = new CaptureSession({
    language: "ta",
    events,
    describeLanguage: (code) => (code === "ta" ? "Tamil" : code),
    interimEmitMinMs: 0,
    restartDelayMs: 1,
    duplicateFinalWindowMs: 1000,
    maxRunsWithoutResult: 2,
    stopDrainMs: 10,
    startWatchdogMs: 25,
    ...overrides,
  });
  live.push(session);
  return {
    session,
    observed,
    current: () => fake.current(),
    instances: () => fake.sessions.length,
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Sessions must not outlive their test: a live session keeps restarting and
 * would create new browser sessions inside the next test's registry. */
let live: CaptureSession[] = [];

beforeEach(() => {
  live = [];
  fake.install();
});

afterEach(() => {
  for (const session of live) session.dispose();
  fake.uninstall();
});

describe("CaptureSession start and results", () => {
  it("starts a session in its language and reports listening", async () => {
    const { session, observed, current } = build();
    session.start();

    assert.deepEqual(observed.capturing, [true]);
    assert.equal(observed.statuses[0], "starting");
    assert.equal(current().lang, "ta");

    await wait(5);
    assert.equal(session.running, true);
    assert.deepEqual(observed.permissions, ["granted"]);
    assert.equal(observed.statuses.at(-1), "listening");
    assert.match(observed.notices.at(-1) ?? "", /speak in Tamil/);
  });

  it("delivers exactly one final per recognized segment", async () => {
    const { session, observed, current } = build();
    session.start();
    await wait(5);

    current().emitResult("Vanakkam", true);
    await wait(2);
    assert.deepEqual(observed.finals, ["Vanakkam"]);
  });

  it("shows an interim line, relays it once, and clears it on the final", async () => {
    const { session, observed, current } = build();
    session.start();
    await wait(5);

    current().emitResult("Vana", false);
    await wait(2);
    assert.deepEqual(observed.localInterims.at(-1), "Vana");
    assert.deepEqual(observed.emittedInterims, ["Vana"]);

    current().emitResult("Vanakkam", true);
    await wait(2);
    assert.deepEqual(observed.finals, ["Vanakkam"]);
    assert.equal(observed.localInterims.at(-1), "");
    assert.equal(observed.emittedInterims.at(-1), "");
  });

  it("drops a duplicate final inside the dedup window", async () => {
    const { session, observed, current } = build();
    session.start();
    await wait(5);

    current().emitResult("Vanakkam", true);
    await wait(2);
    current().emitResult("Vanakkam", true);
    await wait(2);
    assert.deepEqual(observed.finals, ["Vanakkam"]);
  });
});

describe("CaptureSession recovery", () => {
  it("treats a silence timeout as a pause, not a failure", async () => {
    const { session, observed, current } = build();
    session.start();
    await wait(5);

    current().emitError("no-speech");
    await wait(2);
    assert.equal(session.running, true);
    assert.deepEqual(observed.errors, [null]); // only the initial clear
    assert.match(observed.notices.at(-1) ?? "", /Didn't hear anything/);
  });

  it("ignores the aborted error a stop produces", async () => {
    const { session, observed, current } = build();
    session.start();
    await wait(5);

    current().emitError("aborted");
    await wait(2);
    assert.equal(session.running, true);
    assert.deepEqual(observed.errors, [null]);
  });

  it("restarts after an unexpected end while capture is on", async () => {
    const { session, observed, current, instances } = build();
    session.start();
    await wait(5);
    current().emitResult("heard something", true);
    await wait(2);

    current().emitEnd();
    await wait(10);

    assert.equal(instances(), 2);
    assert.equal(session.running, true);
    assert.equal(observed.statuses.at(-1), "listening");
  });

  it("gives up with an actionable error after repeated silent runs", async () => {
    const { session, observed, current } = build();
    session.start();
    await wait(5);

    current().emitEnd();
    await wait(10);
    current().emitEnd();
    await wait(10);

    assert.equal(session.running, false);
    assert.equal(observed.capturing.at(-1), false);
    assert.equal(observed.statuses.at(-1), "error");
    assert.equal(observed.errors.at(-1)?.code, "unexpected_end");
    assert.match(
      observed.errors.at(-1)?.message ?? "",
      /check your microphone/i,
    );
    assert.equal(observed.finals.length, 0);
  });

  it("reports a microphone that never starts, after one retry", async () => {
    fake.silentByDefault = true;
    const { session, observed, instances } = build({ startWatchdogMs: 15 });
    session.start();
    await wait(70);

    assert.equal(instances(), 2);
    assert.equal(session.running, false);
    assert.equal(observed.capturing.at(-1), false);
    assert.equal(observed.statuses.at(-1), "error");
    assert.match(observed.errors.at(-1)?.message ?? "", /never started/i);
  });
});

describe("CaptureSession failures", () => {
  it("reports a denied microphone", async () => {
    const { session, observed, current } = build();
    session.start();
    await wait(5);

    current().emitError("not-allowed");
    await wait(2);
    assert.equal(session.running, false);
    assert.equal(observed.errors.at(-1)?.code, "permission_denied");
    assert.equal(observed.permissions.at(-1), "denied");
    assert.equal(observed.capturing.at(-1), false);
    assert.equal(observed.statuses.at(-1), "error");
    assert.ok(current().aborts + current().stops > 0);
  });

  it("reports a missing microphone", async () => {
    const { session, observed, current } = build();
    session.start();
    await wait(5);

    current().emitError("audio-capture");
    await wait(2);
    assert.equal(observed.errors.at(-1)?.code, "no_microphone");
    assert.equal(session.running, false);
  });

  it("reports an unsupported recognition language", async () => {
    const { session, observed, current } = build();
    session.start();
    await wait(5);

    current().emitError("language-not-supported");
    await wait(2);
    assert.equal(observed.errors.at(-1)?.code, "language_not_supported");
    assert.match(observed.errors.at(-1)?.message ?? "", /speaking language/i);
  });

  it("stops on a network error instead of retrying in a loop", async () => {
    const { session, observed, current, instances } = build();
    session.start();
    await wait(5);

    current().emitError("network");
    // The browser reports `end` after a failure; a superseded end must not
    // restart capture, or a dead service would be hammered in a loop.
    current().emitEnd();
    await wait(30);

    assert.equal(instances(), 1);
    assert.equal(session.running, false);
    assert.equal(observed.capturing.at(-1), false);
    assert.equal(observed.statuses.at(-1), "error");
    assert.equal(observed.errors.at(-1)?.code, "network");
    assert.match(observed.errors.at(-1)?.message ?? "", /network connection/i);
  });

  it("treats a blocked speech service as fatal and does not restart", async () => {
    const { session, observed, current, instances } = build();
    session.start();
    await wait(5);

    current().emitError("service-not-allowed");
    await wait(30);

    assert.equal(instances(), 1);
    assert.equal(session.running, false);
    assert.equal(observed.errors.at(-1)?.code, "permission_denied");
    assert.match(observed.errors.at(-1)?.message ?? "", /blocked its speech/i);
  });

  it("reports a microphone the browser refuses to start", async () => {
    fake.nextStartError = new DOMException("denied", "NotAllowedError");
    const { session, observed, instances } = build();
    session.start();
    await wait(2);

    assert.equal(instances(), 1);
    assert.equal(observed.errors.at(-1)?.code, "permission_denied");
    assert.equal(observed.capturing.at(-1), false);
    assert.equal(session.running, false);
  });
});

describe("CaptureSession stop and disposal", () => {
  it("drains a final phrase, then goes idle", async () => {
    const { session, observed, current } = build();
    session.start();
    await wait(5);

    session.stop();
    assert.equal(observed.statuses.at(-1), "stopping");
    assert.match(observed.notices.at(-1) ?? "", /Microphone off/);

    current().emitResult("last words", true);
    await wait(5);
    assert.deepEqual(observed.finals, ["last words"]);

    await wait(15);
    assert.equal(session.running, false);
    assert.equal(observed.statuses.at(-1), "idle");
    assert.equal(observed.capturing.at(-1), false);
  });

  it("stops following a language change that arrives after stop", async () => {
    const { session, instances } = build();
    session.start();
    await wait(5);
    session.stop();
    await wait(15);

    session.setLanguage("hi");
    await wait(10);
    assert.equal(instances(), 1);
    assert.equal(session.running, false);
  });

  it("restarts into the new language while capturing", async () => {
    const { session, instances, current } = build();
    session.start();
    await wait(5);

    session.setLanguage("hi");
    await wait(10);
    assert.equal(instances(), 2);
    assert.equal(current().lang, "hi");
    assert.equal(session.running, true);
  });

  it("ignores every late browser callback after disposal", async () => {
    const { session, observed, current } = build();
    session.start();
    await wait(5);

    session.dispose();
    const aborted = current();
    const counts = {
      errors: observed.errors.length,
      finals: observed.finals.length,
      statuses: observed.statuses.length,
    };
    aborted.emitResult("too late", true);
    aborted.emitError("network");
    aborted.emitEnd();
    await wait(5);

    assert.equal(observed.errors.length, counts.errors);
    assert.equal(observed.finals.length, counts.finals);
    assert.equal(observed.statuses.length, counts.statuses);
    assert.ok(aborted.aborts > 0);
  });
});
