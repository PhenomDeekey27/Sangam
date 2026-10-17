/**
 * E2E backend: the real Sangam Socket.IO server with deterministic doubles.
 *
 * It boots `createSangamServer` from `server/src` (the same code path a
 * deployment uses) with:
 * - the built-in mock speech provider (`SPEECH_PROVIDER=mock`), which never
 *   performs recognition and never needs a credential, so real microphone audio
 *   can drive the full capture → transcript pipeline;
 * - a scripted translator and a controllable TTS provider injected through the
 *   existing `SangamServerOverrides` seams (no production code is changed).
 *
 * A tiny control HTTP server lets the Playwright test configure TTS delay /
 * failure and read provider call logs. It is bound to localhost only and holds
 * no secrets. Top-level await is avoided so the file runs under tsx from the
 * (CommonJS) repository root.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createSangamServer } from "../../server/src/app.js";
import type { ServerEnv } from "../../server/src/config/env.js";
import {
  ControllableTtsProvider,
  ScriptedTranslator,
  type TtsMode,
} from "./providers.js";

const socketPort = Number(process.env.E2E_SOCKET_PORT ?? 4400);
const controlPort = Number(process.env.E2E_CONTROL_PORT ?? 4401);
const appOrigin = process.env.E2E_APP_ORIGIN ?? "http://127.0.0.1:3100";

const translator = new ScriptedTranslator();
const tts = new ControllableTtsProvider();

/** Config constructed explicitly so no real key or `.env` value is imported. */
const serverEnv: ServerEnv = {
  port: socketPort,
  clientOrigins: [appOrigin, "http://localhost:3100"],
  isProduction: false,
  speech: { provider: "mock" },
  translation: { provider: "none" },
  tts: { provider: "none" },
};

async function main(): Promise<void> {
  const server = createSangamServer(serverEnv, {
    translator,
    ttsProvider: tts,
  });
  await server.listen();
  console.log(
    `[e2e-backend] sangam server on :${socketPort} (mock speech, scripted translation/TTS)`,
  );

  const control = createServer((request, response) => {
    void handleControl(request, response);
  });
  control.listen(controlPort, "127.0.0.1", () => {
    console.log(`[e2e-backend] control server on :${controlPort}`);
  });

  const shutdown = (): void => {
    control.close();
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  response.end(JSON.stringify(body));
}

async function readJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

function statePayload(): Record<string, unknown> {
  return {
    ok: true,
    tts: {
      mode: tts.currentMode,
      durationMs: tts.currentDurationMs,
      pending: tts.pending,
      calls: tts.calls,
    },
    translator: { calls: translator.calls },
  };
}

async function handleControl(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const route = `${request.method ?? "GET"} ${url.pathname}`;

  if (route === "GET /health") return sendJson(response, 200, { ok: true });
  if (route === "GET /state") return sendJson(response, 200, statePayload());

  if (route === "POST /tts/configure") {
    const body = await readJson(request);
    tts.configure({
      mode: typeof body.mode === "string" ? (body.mode as TtsMode) : undefined,
      durationMs:
        typeof body.durationMs === "number" ? body.durationMs : undefined,
    });
    return sendJson(response, 200, {
      ok: true,
      mode: tts.currentMode,
      durationMs: tts.currentDurationMs,
    });
  }

  if (route === "POST /tts/release") {
    return sendJson(response, 200, { ok: true, released: tts.release() });
  }

  if (route === "POST /reset") {
    tts.reset();
    translator.reset();
    return sendJson(response, 200, { ok: true });
  }

  sendJson(response, 404, { ok: false, error: `unknown route: ${route}` });
}

void main();
