import type { PlaybackUnavailablePayload } from "@/types/socket";

/**
 * Last-resort playback for translated text: the browser's own
 * `speechSynthesis`. The server asks the client to speak locally
 * (`conversation:playback_unavailable`) whenever no server audio will arrive,
 * so the listener still *hears* the translation instead of only reading it.
 *
 * The same invariants the server-audio queue holds apply here:
 * - one utterance id is spoken at most once, ever,
 * - a stale sequence (at or below the played/interrupted watermark) is dropped,
 * - items are spoken strictly in ascending `sequence` order,
 * - `interrupt(boundary)` cancels the active line and drops the interrupted
 *   turn while keeping genuinely newer speech,
 * - `reset()` forgets everything for a disconnect, leave, or room change.
 *
 * The engine is injectable so tests never touch a real speech synthesizer.
 */

/** The slice of `window.speechSynthesis` this fallback needs. */
export interface SpeechSynthesisEngine {
  readonly supported: boolean;
  speak(utterance: SpeechSynthesisUtterance): void;
  cancel(): void;
  voices(): readonly SpeechSynthesisVoice[];
  createUtterance(text: string): SpeechSynthesisUtterance;
}

/** Wrap the real browser synthesizer, guarded for SSR/unsupported browsers. */
export function browserSpeechEngine(): SpeechSynthesisEngine {
  const scope = typeof window !== "undefined" ? window : undefined;
  const synth = scope?.speechSynthesis;
  const Utterance = scope?.SpeechSynthesisUtterance;
  const supported = Boolean(synth && Utterance);
  return {
    supported,
    speak: (utterance) => synth?.speak(utterance),
    cancel: () => synth?.cancel(),
    voices: () => (synth?.getVoices ? synth.getVoices() : []),
    createUtterance: (text) => new (Utterance as NonNullable<typeof Utterance>)(text),
  };
}

export interface SpeechSynthesisFallbackOptions {
  /** Translated text for one utterance id, or `null` when not yet available. */
  readonly getText: (utteranceId: string) => string | null;
  /** Injectable engine; defaults to the real browser synthesizer. */
  readonly engine?: SpeechSynthesisEngine;
}

export class SpeechSynthesisFallback {
  private readonly engine: SpeechSynthesisEngine;
  private getText: (utteranceId: string) => string | null;
  private pending: PlaybackUnavailablePayload[] = [];
  private current: SpeechSynthesisUtterance | null = null;
  private readonly seen = new Set<string>();
  private watermark = 0;

  constructor(options: SpeechSynthesisFallbackOptions) {
    this.engine = options.engine ?? browserSpeechEngine();
    this.getText = options.getText;
  }

  /**
   * Swap the transcript lookup (the hook keeps the freshest closure without
   * rebuilding the fallback and losing its ordering watermark).
   */
  setGetText(getText: (utteranceId: string) => string | null): void {
    this.getText = getText;
  }

  /** True when this browser can speak text at all. */
  get supported(): boolean {
    return this.engine.supported;
  }

  /** Number of items waiting behind the active one. */
  get size(): number {
    return this.pending.length;
  }

  /** Everything at or below this sequence is closed (played or interrupted). */
  get playedUpTo(): number {
    return this.watermark;
  }

  /** Queue one local speech request. Returns `false` when it was dropped. */
  enqueue(payload: PlaybackUnavailablePayload): boolean {
    if (!this.supported) return false;
    if (this.seen.has(payload.utteranceId)) return false;
    if (payload.sequence <= this.watermark) return false;
    this.seen.add(payload.utteranceId);
    const index = this.pending.findIndex(
      (queued) => queued.sequence > payload.sequence,
    );
    if (index === -1) this.pending.push(payload);
    else this.pending.splice(index, 0, payload);
    this.pump();
    return true;
  }

  /** Cancel the interrupted turn at or below `boundary`, keep newer speech. */
  interrupt(boundary: number): void {
    if (!Number.isFinite(boundary)) return;
    const value = Math.max(0, Math.floor(boundary));
    // Advance the watermark even with nothing playing/queued: a late frame for
    // the interrupted turn (or a stale audio blob) must never resurrect it.
    if (value <= this.watermark) return;
    this.watermark = value;
    this.pending = this.pending.filter((item) => item.sequence > value);
    if (this.current) {
      this.current = null;
      this.engine.cancel();
    }
    this.pump();
  }

  /** Forget everything: queued lines, seen ids, and the watermark. */
  reset(): void {
    this.pending = [];
    this.seen.clear();
    this.watermark = 0;
    if (this.current) {
      this.current = null;
      this.engine.cancel();
    }
  }

  /** Speak the next queued line if nothing is currently speaking. */
  private pump(): void {
    if (this.current) return;
    const next = this.pending.shift();
    if (!next) return;
    const text = (this.getText(next.utteranceId) ?? "").trim();
    if (text.length === 0) {
      this.advance(next.sequence);
      return;
    }
    const utterance = this.engine.createUtterance(text);
    utterance.lang = next.language;
    const voice = this.pickVoice(next.language);
    if (voice) utterance.voice = voice;
    utterance.onend = () => this.finish(utterance, next.sequence);
    utterance.onerror = () => this.finish(utterance, next.sequence);
    this.current = utterance;
    this.engine.speak(utterance);
  }

  private finish(utterance: SpeechSynthesisUtterance, sequence: number): void {
    // A cancel() also fires an end/error event; only the still-active line may
    // advance the watermark and start the next one.
    if (this.current !== utterance) return;
    this.advance(sequence);
  }

  private advance(sequence: number): void {
    if (sequence > this.watermark) this.watermark = Math.floor(sequence);
    this.current = null;
    this.pump();
  }

  /** Best-effort voice for a language; the browser default when none match. */
  private pickVoice(language: string): SpeechSynthesisVoice | null {
    const target = language.toLowerCase();
    return (
      this.engine
        .voices()
        .find((voice) => voice.lang?.toLowerCase().startsWith(target)) ?? null
    );
  }
}
