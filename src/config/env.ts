/**
 * Browser-safe environment values.
 *
 * Only `NEXT_PUBLIC_*` variables may be read here, because this module can be
 * imported by client components and its values are inlined into the browser
 * bundle. Server-only secrets (for example the speech provider's API key) must
 * be read from `process.env` inside server code and never imported here.
 *
 * See `.env.example` for documented placeholders.
 */

/** How this deployment prefers to run speech recognition. */
export type SpeechTransportPreference = "auto" | "browser" | "server";

function readSpeechTransport(): SpeechTransportPreference {
  const raw = process.env.NEXT_PUBLIC_SPEECH_PROVIDER?.trim().toLowerCase();
  return raw === "browser" || raw === "server" ? raw : "auto";
}

export const env = {
  /** Base URL of the real-time conversation server (Socket.IO), set in `.env.local`. */
  socketUrl: process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:4000",
  /**
   * Preferred speech pipeline. `auto` uses the server pipeline when the backend
   * reports one, and otherwise falls back to the browser's own recognition.
   */
  speechProvider: readSpeechTransport(),
} as const;
