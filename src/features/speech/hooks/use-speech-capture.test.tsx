import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { useSpeechCapture } from "@/features/speech/hooks/use-speech-capture";
import { FakeSpeechRecognition } from "@/test/fake-speech-recognition";
import { mountHook, type HookHarness } from "@/test/react-harness";
import type { SpeechCapture } from "@/features/speech/hooks/use-speech-capture";

interface CaptureOptions {
  readonly language: string;
  readonly finals: string[];
  readonly interims: string[];
  readonly notices: string[];
}

const fake = new FakeSpeechRecognition();
let mounted: HookHarness<SpeechCapture, CaptureOptions>[] = [];

function options(language = "ta"): CaptureOptions {
  return { language, finals: [], interims: [], notices: [] };
}

function mountCapture(opts: CaptureOptions, strict = true) {
  const harness = mountHook(
    (props: CaptureOptions) =>
      useSpeechCapture({
        language: props.language,
        onFinalText: (text) => props.finals.push(text),
        onInterimEmit: (text) => props.interims.push(text),
        onNotice: (message) => props.notices.push(message),
      }),
    { strict, props: opts },
  );
  return harness.then((mountedHarness) => {
    mounted.push(mountedHarness);
    return mountedHarness;
  });
}

beforeEach(() => {
  mounted = [];
  fake.install();
});

afterEach(async () => {
  for (const harness of mounted) await harness.unmount();
  fake.uninstall();
});

describe("useSpeechCapture in a Strict Mode tree", () => {
  it("starts recognition in the selected language and reaches a final result", async () => {
    const opts = options("ta");
    const harness = await mountCapture(opts);

    await harness.perform(() => harness.current().toggle());
    await harness.advance(10);

    assert.equal(fake.current().lang, "ta");
    assert.equal(fake.current().continuous, true);
    assert.equal(harness.current().capturing, true);
    assert.equal(harness.current().status, "listening");
    assert.match(opts.notices.at(-1) ?? "", /speak in Tamil/);

    await harness.perform(() => fake.current().emitResult("Vanakkam", true));
    await harness.advance(10);

    assert.deepEqual(opts.finals, ["Vanakkam"]);
  });

  it("shows an interim line, relays it, then finalizes it", async () => {
    const opts = options("hi");
    const harness = await mountCapture(opts);
    await harness.perform(() => harness.current().toggle());
    await harness.advance(10);

    await harness.perform(() => fake.current().emitResult("Vana", false));
    await harness.advance(10);
    assert.equal(harness.current().interim, "Vana");
    assert.equal(opts.interims.at(-1), "Vana");

    await harness.perform(() => fake.current().emitResult("Vanakkam", true));
    await harness.advance(10);
    assert.deepEqual(opts.finals, ["Vanakkam"]);
    assert.equal(harness.current().interim, "");
    assert.equal(opts.interims.at(-1), "");
  });

  it("keeps recognition alive across the Strict Mode remount", async () => {
    const opts = options("en");
    const harness = await mountCapture(opts);
    await harness.perform(() => harness.current().toggle());
    await harness.advance(10);

    // A remount of the effect (Strict Mode, Fast Refresh, hydration recovery)
    // must not leave a running session whose callbacks are ignored.
    await harness.setProps({ ...opts });
    await harness.advance(10);

    await harness.perform(() => fake.current().emitResult("still heard", true));
    await harness.advance(10);
    assert.deepEqual(opts.finals, ["still heard"]);
  });
});

describe("useSpeechCapture support and errors", () => {
  it("reports an unsupported browser without starting a session", async () => {
    fake.uninstall();
    const opts = options();
    const harness = await mountCapture(opts);
    assert.equal(harness.current().support, "unsupported");

    await harness.perform(() => harness.current().toggle());
    await harness.advance(5);

    assert.equal(harness.current().error?.code, "not_supported");
    assert.equal(harness.current().capturing, false);
    assert.equal(fake.sessions.length, 0);
    assert.match(opts.notices.at(-1) ?? "", /isn't supported/i);
  });

  it("surfaces a denied microphone and stops capturing", async () => {
    const opts = options();
    const harness = await mountCapture(opts);
    await harness.perform(() => harness.current().toggle());
    await harness.advance(10);

    await harness.perform(() => fake.current().emitError("not-allowed"));
    await harness.advance(10);

    assert.equal(harness.current().error?.code, "permission_denied");
    assert.equal(harness.current().permission, "denied");
    assert.equal(harness.current().capturing, false);
    assert.equal(harness.current().status, "error");
    assert.match(opts.notices.at(-1) ?? "", /allow the microphone/i);
  });

  it("reports a missing microphone with actionable copy", async () => {
    const opts = options();
    const harness = await mountCapture(opts);
    await harness.perform(() => harness.current().toggle());
    await harness.advance(10);

    await harness.perform(() => fake.current().emitError("audio-capture"));
    await harness.advance(10);

    assert.equal(harness.current().error?.code, "no_microphone");
    assert.match(harness.current().error?.message ?? "", /connect one/i);
  });
});

describe("useSpeechCapture cleanup", () => {
  it("mic off stops the session and clears the interim line for the partner", async () => {
    const opts = options();
    const harness = await mountCapture(opts);
    await harness.perform(() => harness.current().toggle());
    await harness.advance(10);
    await harness.perform(() => fake.current().emitResult("partial", false));
    await harness.advance(5);

    const session = fake.current();
    await harness.perform(() => harness.current().stop());
    await harness.advance(30);

    assert.equal(session.stops, 1);
    assert.equal(harness.current().capturing, false);
    assert.equal(harness.current().status, "idle");
    assert.equal(harness.current().interim, "");
    assert.equal(opts.interims.at(-1), "");
  });

  it("toggle turns capture off again", async () => {
    const harness = await mountCapture(options());
    await harness.perform(() => harness.current().toggle());
    await harness.advance(10);
    assert.equal(harness.current().capturing, true);

    await harness.perform(() => harness.current().toggle());
    await harness.advance(30);
    assert.equal(harness.current().capturing, false);
  });

  it("unmount aborts the session and mutes later callbacks", async () => {
    const opts = options();
    const harness = await mountCapture(opts);
    await harness.perform(() => harness.current().toggle());
    await harness.advance(10);
    const session = fake.current();

    await harness.unmount();
    assert.ok(session.aborts > 0);

    session.emitResult("after unmount", true);
    session.emitError("network");
    session.emitEnd();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(opts.finals, []);
  });

  it("follows a speaking-language change with a fresh session", async () => {
    const opts = options("ta");
    const harness = await mountCapture(opts);
    await harness.perform(() => harness.current().toggle());
    await harness.advance(10);
    assert.equal(fake.sessions.length, 1);

    await harness.setProps({ ...opts, language: "bn" });
    await harness.advance(10);

    assert.equal(fake.sessions.length, 2);
    assert.equal(fake.current().lang, "bn");
    assert.equal(harness.current().capturing, true);

    await harness.perform(() => fake.current().emitResult("Nomoshkar", true));
    await harness.advance(10);
    assert.deepEqual(opts.finals, ["Nomoshkar"]);
  });
});
