/**
 * Browser-safe environment values.
 *
 * Only `NEXT_PUBLIC_*` variables may be read here, because this module can be
 * imported by client components and its values are inlined into the browser
 * bundle. Server-only secrets (for example translation provider keys) must be
 * read from `process.env` inside server code and never imported here.
 *
 * See `.env.example` for documented placeholders.
 */
export const env = {
  /** Base URL of the real-time conversation server (Socket.IO), set in `.env.local`. */
  socketUrl: process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:4000",
} as const;
