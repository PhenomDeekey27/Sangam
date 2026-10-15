/**
 * Server-side configuration, validated once at startup.
 *
 * The browser must only ever see `NEXT_PUBLIC_*` values from the frontend
 * `.env.local`; everything validated here stays inside the Node process.
 * See the repository `.env.example` for documented placeholders.
 */
export interface ServerEnv {
  /** TCP port the HTTP + Socket.IO server listens on. */
  readonly port: number;
  /** Exact browser origins allowed by CORS (never `*` in production). */
  readonly clientOrigins: readonly string[];
  readonly isProduction: boolean;
}

const DEV_DEFAULT_ORIGIN = "http://localhost:3000";
const PORT_FALLBACK = 4000;

function parsePort(value: string | undefined): number {
  const port =
    value === undefined || value === "" ? PORT_FALLBACK : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(
      `PORT must be an integer between 0 and 65535, got "${value}"`,
    );
  }
  return port;
}

function parseOrigins(
  value: string | undefined,
  isProduction: boolean,
): string[] {
  const raw = value?.trim() ?? DEV_DEFAULT_ORIGIN;
  const origins = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (origins.length === 0) {
    throw new Error("CLIENT_ORIGIN must list at least one origin");
  }
  for (const origin of origins) {
    if (origin === "*") {
      if (isProduction) {
        throw new Error("Wildcard CORS (*) is not allowed in production");
      }
      continue;
    }
    try {
      const url = new URL(origin);
      if (url.pathname !== "/" || url.search || url.hash) {
        throw new Error("origin must be scheme://host[:port] with no path");
      }
    } catch (error) {
      throw new Error(
        `CLIENT_ORIGIN contains an invalid origin "${origin}": ${String(error)}`,
      );
    }
  }
  return origins;
}

/** Read and validate configuration, throwing a descriptive error on misuse. */
export function loadEnv(raw: NodeJS.ProcessEnv = process.env): ServerEnv {
  const isProduction = raw.NODE_ENV === "production";
  return {
    port: parsePort(raw.PORT),
    clientOrigins: parseOrigins(raw.CLIENT_ORIGIN, isProduction),
    isProduction,
  };
}
