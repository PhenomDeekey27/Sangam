import type { UtteranceId } from "@/features/conversation/types";

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Maximum accepted utterance-id length; mirrors the server's validator in
 * `server/src/sockets/event-validation.ts` so a generated id always passes.
 */
export const MAX_UTTERANCE_ID_LENGTH = 64;

/**
 * Generate a stable, server-validatable id for one utterance. Uses
 * `crypto.randomUUID()` (hyphens allowed) when available, with a
 * `getRandomValues` fallback for older secure contexts. The id is created on
 * the originating client so re-emits across reconnects stay deduplicable.
 */
export function newUtteranceId(): UtteranceId {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  const bytes = new Uint8Array(16);
  cryptoApi?.getRandomValues(bytes);
  let id = "";
  for (const byte of bytes) {
    id += byte.toString(16).padStart(2, "0");
  }
  return id;
}

/** True when an id matches the shape the server accepts. */
export function isValidUtteranceId(id: string): boolean {
  return (
    id.length > 0 && id.length <= MAX_UTTERANCE_ID_LENGTH && ID_PATTERN.test(id)
  );
}
