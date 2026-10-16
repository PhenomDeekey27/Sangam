/**
 * Per-connection speech capabilities, shared process-wide.
 *
 * The room socket receives a `speech:capabilities` frame once per connection;
 * the capture hook reads it to decide whether to stream audio to the server's
 * provider instead of relying on the browser's own recognition. Keeping the
 * value in a tiny external store (rather than prop-drilling it through the room
 * tree) lets both sides subscribe without either owning the other.
 *
 * The store never holds a credential: `SpeechCapabilities` is only a provider
 * label and its feature flags.
 */
import type { SpeechCapabilities } from "@/types/socket";

type Listener = () => void;

let current: SpeechCapabilities | null = null;
const listeners = new Set<Listener>();

/** Latest advertised capabilities, or `null` before the first frame. */
export function getSpeechCapabilities(): SpeechCapabilities | null {
  return current;
}

/** Publish the server's capabilities; `null` clears them on disconnect. */
export function setSpeechCapabilities(next: SpeechCapabilities | null): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

/** Stable snapshot accessor for `useSyncExternalStore`'s server render pass. */
export function getServerSpeechCapabilities(): SpeechCapabilities | null {
  return null;
}

/** Subscribe to capability changes; returns the unsubscribe function. */
export function subscribeSpeechCapabilities(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
