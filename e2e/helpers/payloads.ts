/**
 * Typed views over the raw Socket.IO frames captured by `diagnostics.ts`.
 *
 * The wire payloads are `unknown` once decoded from the transport, so each
 * helper narrows one field at a time and returns a plain view. A shape change
 * therefore fails a test as a clear assertion (an empty string or 0) instead of
 * an opaque crash, and no `any` is needed to read them.
 */
import type { Diagnostics, SocketRecord } from "./diagnostics";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`expected an object payload, received ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/** The nested `entry.utterance` object of a `conversation:utterance` frame. */
function utteranceOf(data: unknown): Record<string, unknown> {
  return record(record(record(data).entry).utterance);
}

export function utteranceIdOf(data: unknown): string {
  return asText(utteranceOf(data).id);
}

export function utteranceTextOf(data: unknown): string {
  return asText(utteranceOf(data).text);
}

export function utteranceLanguageOf(data: unknown): string {
  return asText(utteranceOf(data).language);
}

export function utteranceSideOf(data: unknown): string {
  return asText(utteranceOf(data).speakerSide);
}

export function utteranceSequenceOf(data: unknown): number {
  return asNumber(utteranceOf(data).sequence);
}

/** Translated text of a `conversation:translation` frame (`""` while failed). */
export function translationTextOf(data: unknown): string {
  const translation = record(record(data).translation);
  return asText(translation.text);
}

export function translationTargetOf(data: unknown): string {
  return asText(record(record(data).translation).targetLanguage);
}

export interface PlaybackView {
  readonly utteranceId: string;
  readonly sequence: number;
  readonly language: string;
  readonly mimeType: string;
}

/** The metadata object of a `conversation:playback` frame (audio is separate). */
export function playbackView(data: unknown): PlaybackView {
  const payload = record(data);
  return {
    utteranceId: asText(payload.utteranceId),
    sequence: asNumber(payload.sequence),
    language: asText(payload.language),
    mimeType: asText(payload.mimeType),
  };
}

export interface UnavailableView {
  readonly utteranceId: string;
  readonly sequence: number;
  readonly language: string;
  readonly reason: string;
}

export function unavailableView(data: unknown): UnavailableView {
  const payload = record(data);
  return {
    utteranceId: asText(payload.utteranceId),
    sequence: asNumber(payload.sequence),
    language: asText(payload.language),
    reason: asText(payload.reason),
  };
}

export interface InterruptView {
  readonly side: string;
  readonly sequence: number;
  readonly interruptId: string;
}

export function interruptView(data: unknown): InterruptView {
  const payload = record(data);
  return {
    side: asText(payload.side),
    sequence: asNumber(payload.sequence),
    interruptId: asText(payload.interruptId),
  };
}

/** Frames of one event the page received, in arrival order. */
export function received(diag: Diagnostics, event: string): SocketRecord[] {
  return diag.socket.items.filter(
    (frame) => frame.direction === "in" && frame.event === event,
  );
}
