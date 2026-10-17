import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  LatencyTracker,
  latencyTracker,
  logLatency,
  markLatency,
  markUtteranceReceived,
  resetLatency,
} from "@/features/conversation/utils/latency";

describe("LatencyTracker", () => {
  it("derives each leg's gap from the recorded stages", () => {
    const tracker = new LatencyTracker();
    tracker.mark("u1", "final", 1_000);
    tracker.mark("u1", "utterance", 1_060);
    tracker.mark("u1", "translation", 1_310);
    tracker.mark("u1", "audio", 2_010);
    tracker.mark("u1", "playback", 2_070);

    const report = tracker.report("u1");
    assert.ok(report);
    assert.equal(report.translationMs, 250);
    assert.equal(report.ttsMs, 700);
    assert.equal(report.playbackMs, 60);
    assert.equal(report.totalMs, 1_010);
    assert.equal(report.serverToPlaybackMs, 1_070);
  });

  it("keeps the first timestamp per stage, so a duplicate frame cannot move it", () => {
    const tracker = new LatencyTracker();
    tracker.mark("u1", "audio", 500);
    tracker.mark("u1", "audio", 9_999);
    assert.equal(tracker.report("u1")?.marks.audio, 500);
  });

  it("reports null gaps until both ends exist", () => {
    const tracker = new LatencyTracker();
    tracker.mark("u1", "utterance", 100);
    const report = tracker.report("u1");
    assert.ok(report);
    assert.equal(report.translationMs, null);
    assert.equal(report.ttsMs, null);
    assert.equal(report.playbackMs, null);
    assert.equal(report.totalMs, null);
    assert.equal(report.serverToPlaybackMs, null);
  });

  it("returns null for an utterance that was never marked", () => {
    assert.equal(new LatencyTracker().report("missing"), null);
  });

  it("finish reports once and then forgets the utterance", () => {
    const tracker = new LatencyTracker();
    tracker.mark("u1", "utterance", 10);
    tracker.mark("u1", "playback", 40);
    const first = tracker.finish("u1");
    assert.equal(first?.totalMs, 30);
    assert.equal(tracker.finish("u1"), null);
    assert.equal(tracker.report("u1"), null);
  });

  it("bounds tracked utterances to the configured maximum", () => {
    const tracker = new LatencyTracker({ maxEntries: 2 });
    tracker.mark("u1", "utterance", 1);
    tracker.mark("u2", "utterance", 2);
    tracker.mark("u3", "utterance", 3);
    assert.equal(tracker.report("u1"), null);
    assert.ok(tracker.report("u2"));
    assert.ok(tracker.report("u3"));
  });

  it("ignores an empty utterance id", () => {
    const tracker = new LatencyTracker();
    tracker.mark("", "utterance", 1);
    assert.equal(tracker.report(""), null);
  });
});

describe("markUtteranceReceived", () => {
  it("marks local receipt plus the server's finalize stamp", () => {
    resetLatency();
    markUtteranceReceived({
      utterance: { id: "shared-1", finalizedAt: 4_242 },
    });
    const report = latencyTracker.report("shared-1");
    assert.ok(report);
    assert.equal(report.marks.final, 4_242);
    assert.equal(typeof report.marks.utterance, "number");
    resetLatency();
  });

  it("tolerates a missing finalize stamp", () => {
    resetLatency();
    markUtteranceReceived({ utterance: { id: "shared-2" } });
    const report = latencyTracker.report("shared-2");
    assert.ok(report);
    assert.equal(report.marks.final, undefined);
    assert.equal(typeof report.marks.utterance, "number");
    resetLatency();
  });
});

describe("markLatency / logLatency", () => {
  const originalDebug = console.debug;
  afterEach(() => {
    console.debug = originalDebug;
    resetLatency();
    setNodeEnv(undefined);
  });

  it("logs one safe line in development", () => {
    const lines: string[] = [];
    console.debug = (message?: unknown) => {
      lines.push(String(message));
    };
    setNodeEnv("development");
    markLatency("log-1", "utterance", 100);
    markLatency("log-1", "playback", 400);
    logLatency(latencyTracker.report("log-1")!);
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /\[sangam\] latency log-1/);
    assert.match(lines[0] ?? "", /total=300ms/);
  });

  it("stays silent in production", () => {
    let calls = 0;
    console.debug = () => {
      calls += 1;
    };
    setNodeEnv("production");
    markLatency("log-2", "utterance", 100);
    markLatency("log-2", "playback", 400);
    logLatency(latencyTracker.report("log-2")!);
    assert.equal(calls, 0);
  });
});

/** NODE_ENV is declared readonly by Next's ambient types. */
function setNodeEnv(value: string | undefined): void {
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = value;
}
