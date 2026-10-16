import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { SpeechCapabilities } from "@/types/socket";
import {
  getSpeechCapabilities,
  setSpeechCapabilities,
  subscribeSpeechCapabilities,
} from "@/features/speech/services/speech-capabilities";
import {
  selectTransport,
  useSpeechCapture,
} from "@/features/speech/hooks/use-speech-capture";
import { FakeSpeechRecognition } from "@/test/fake-speech-recognition";
import { mountHook, type HookHarness } from "@/test/react-harness";
import type { SpeechCapture } from "@/features/speech/hooks/use-speech-capture";

const browserCapabilities: SpeechCapabilities = {
  provider: "none",
  streaming: false,
  interim: false,
  languages: [],
};
const serverCapabilities: SpeechCapabilities = {
  provider: "mock",
  streaming: true,
  interim: true,
  languages: ["ta", "te", "hi", "en"],
};

describe("selectTransport", () => {
  it("prefers the server pipeline in auto mode", () => {
    assert.equal(
      selectTransport({
        preference: "auto",
        browserReady: true,
        serverReady: true,
      }),
      "server",
    );
  });

  it("falls back to the browser only when no server pipeline exists", () => {
    assert.equal(
      selectTransport({
        preference: "auto",
        browserReady: true,
        serverReady: false,
      }),
      "browser",
    );
    assert.equal(
      selectTransport({
        preference: "auto",
        browserReady: false,
        serverReady: false,
      }),
      "none",
    );
  });

  it("never silently crosses an explicit preference", () => {
    assert.equal(
      selectTransport({
        preference: "server",
        browserReady: true,
        serverReady: false,
      }),
      "none",
    );
    assert.equal(
      selectTransport({
        preference: "browser",
        browserReady: false,
        serverReady: true,
      }),
      "none",
    );
  });
});

describe("speech capabilities store", () => {
  beforeEach(() => setSpeechCapabilities(null));
  afterEach(() => setSpeechCapabilities(null));

  it("notifies subscribers and clears on disconnect", () => {
    let changes = 0;
    const unsubscribe = subscribeSpeechCapabilities(() => {
      changes += 1;
    });

    setSpeechCapabilities(serverCapabilities);
    assert.equal(getSpeechCapabilities()?.provider, "mock");
    assert.equal(changes, 1);

    // Setting the same reference is a no-op; clearing notifies once.
    setSpeechCapabilities(serverCapabilities);
    assert.equal(changes, 1);
    setSpeechCapabilities(null);
    assert.equal(getSpeechCapabilities(), null);
    assert.equal(changes, 2);

    unsubscribe();
    setSpeechCapabilities(serverCapabilities);
    assert.equal(changes, 2);
  });
});

/** Install just enough of the MediaRecorder API for `isMicCaptureSupported`. */
function installMicSupport(): void {
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: () => Promise.reject(new Error("unused")) },
    configurable: true,
  });
  (globalThis as unknown as Record<string, unknown>).MediaRecorder =
    function MediaRecorder() {};
}

function uninstallMicSupport(): void {
  delete (globalThis as unknown as Record<string, unknown>).MediaRecorder;
  delete (navigator as unknown as Record<string, unknown>).mediaDevices;
}

interface CaptureOptions {
  readonly language: string;
}

let mounted: HookHarness<SpeechCapture, CaptureOptions>[] = [];
const fake = new FakeSpeechRecognition();

beforeEach(() => {
  mounted = [];
});
afterEach(async () => {
  for (const harness of mounted) await harness.unmount();
  fake.uninstall();
  uninstallMicSupport();
  setSpeechCapabilities(null);
});

function mount() {
  const harness = mountHook(
    (props: CaptureOptions) =>
      useSpeechCapture({
        language: props.language,
        onFinalText: () => {},
        onInterimEmit: () => {},
      }),
    { strict: true, props: { language: "ta" } },
  );
  return harness.then((live) => {
    mounted.push(live);
    return live;
  });
}

describe("useSpeechCapture transport selection", () => {
  it("uses the server pipeline when a provider is advertised", async () => {
    installMicSupport();
    setSpeechCapabilities(serverCapabilities);

    const harness = await mount();

    assert.equal(harness.current().transport, "server");
    assert.equal(harness.current().support, "supported");
  });

  it("falls back to the browser when the server advertises no provider", async () => {
    fake.install();
    setSpeechCapabilities(browserCapabilities);

    const harness = await mount();

    assert.equal(harness.current().transport, "browser");
    assert.equal(harness.current().support, "supported");
  });

  it("reports no pipeline and stays honest when nothing is available", async () => {
    const harness = await mount();

    assert.equal(harness.current().transport, "none");
    assert.equal(harness.current().support, "unsupported");

    await harness.perform(() => harness.current().toggle());
    assert.equal(harness.current().error?.code, "not_supported");
  });
});
