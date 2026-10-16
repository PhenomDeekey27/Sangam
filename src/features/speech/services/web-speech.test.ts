import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createBrowserRecognition,
  getSpeechRecognitionCtor,
  isSpeechRecognitionSupported,
  mapRecognitionError,
  type RecognitionHandlers,
} from "@/features/speech/services/web-speech";
import { FakeSpeechRecognition } from "@/test/fake-speech-recognition";

interface Recorder {
  starts: number;
  readonly interims: string[];
  readonly finals: string[];
  readonly errors: string[];
  ends: number;
}

const fake = new FakeSpeechRecognition();

function recorder(): RecognitionHandlers & { readonly log: Recorder } {
  const log: Recorder = {
    starts: 0,
    interims: [],
    finals: [],
    errors: [],
    ends: 0,
  };
  return {
    onStart: () => {
      log.starts += 1;
    },
    onInterim: (text) => log.interims.push(text),
    onFinal: (text) => log.finals.push(text),
    onError: (error) => log.errors.push(error.code),
    onEnd: () => {
      log.ends += 1;
    },
    log,
  };
}

beforeEach(() => {
  fake.install();
});

afterEach(() => {
  fake.uninstall();
});

describe("recognition error mapping", () => {
  it("maps the errors a browser actually reports to actionable copy", () => {
    const cases: readonly [string, string, RegExp][] = [
      ["not-allowed", "permission_denied", /allow the microphone/i],
      ["service-not-allowed", "permission_denied", /blocked its speech/i],
      ["audio-capture", "no_microphone", /No microphone/i],
      ["audio-busy", "no_microphone", /Another app is using/i],
      ["network", "network", /network connection/i],
      ["no-speech", "no_speech", /Didn't hear anything/i],
      [
        "language-not-supported",
        "language_not_supported",
        /another speaking language/i,
      ],
      ["aborted", "aborted", /stopped/i],
      ["something-new", "unknown", /off and on again|type your message/i],
    ];
    for (const [raw, code, message] of cases) {
      const mapped = mapRecognitionError(raw);
      assert.equal(mapped.code, code, `${raw} should map to ${code}`);
      assert.match(mapped.message, message);
    }
  });

  it("never returns an empty message", () => {
    for (const raw of ["", "audio-capture", "nonsense"]) {
      assert.ok(mapRecognitionError(raw).message.length > 10);
    }
  });

  it("recommends a supported browser when the speech service itself fails", () => {
    // Brave and similar privacy browsers block the vendor's recognition
    // service; the copy must point somewhere actionable, not blame the user.
    for (const raw of ["network", "service-not-allowed"]) {
      assert.match(mapRecognitionError(raw).message, /Chrome, Edge, or Safari/);
    }
  });
});

describe("constructor detection", () => {
  it("finds the installed constructor", () => {
    assert.equal(isSpeechRecognitionSupported(), true);
    assert.ok(getSpeechRecognitionCtor());
  });

  it("reports unsupported when the browser has no constructor", () => {
    fake.uninstall();
    assert.equal(isSpeechRecognitionSupported(), false);
    assert.equal(getSpeechRecognitionCtor(), null);
    assert.throws(() => createBrowserRecognition("en", recorder()));
    fake.install();
  });
});

describe("createBrowserRecognition", () => {
  it("configures the selected language for continuous interim recognition", () => {
    createBrowserRecognition("hi", recorder());
    const session = fake.current();
    assert.equal(session.lang, "hi");
    assert.equal(session.continuous, true);
    assert.equal(session.interimResults, true);
    assert.equal(session.maxAlternatives, 1);
  });

  it("forwards start, interim, final, error, and end to the handlers", () => {
    const handlers = recorder();
    const recognition = createBrowserRecognition("ta", handlers);
    recognition.start();
    const session = fake.current();
    assert.equal(session.starts, 1);

    session.emitResult("Vana", false);
    assert.deepEqual(handlers.log.interims, ["Vana"]);

    session.emitResult("Vanakkam", true);
    assert.deepEqual(handlers.log.finals, ["Vanakkam"]);

    session.emitError("network");
    assert.deepEqual(handlers.log.errors, ["network"]);

    session.emitEnd();
    assert.equal(handlers.log.ends, 1);
  });

  it("ignores a final result whose transcript is blank", () => {
    const handlers = recorder();
    createBrowserRecognition("en", handlers);
    fake.current().emitResult("   ", true);
    assert.deepEqual(handlers.log.finals, []);
  });

  it("relays only the interim tail when the browser reports earlier finals", () => {
    const handlers = recorder();
    createBrowserRecognition("en", handlers);
    const session = fake.current();
    session.emitResult("already final", true, 0);
    session.emitResult("still typing", false, 1);
    assert.deepEqual(handlers.log.finals, ["already final"]);
    assert.deepEqual(handlers.log.interims, ["still typing"]);
  });
});
