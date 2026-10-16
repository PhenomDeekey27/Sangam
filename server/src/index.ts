import { createSangamServer } from "./app.js";
import { loadEnv } from "./config/env.js";

/**
 * Process entry point. Validates configuration first so a misconfigured
 * server refuses to start rather than serving with unsafe defaults.
 *
 * IMPORTANT: room membership and conversation state live only in this
 * process's memory. A restart forgets every room; running more than one
 * instance splits rooms across processes that cannot see each other.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const server = createSangamServer(env);
  await server.listen();
  console.log(
    `[sangam] listening on port ${env.port}; CORS origins: ${env.clientOrigins.join(", ")}`,
  );
  // Safe startup summary: the provider id and whether a key is configured,
  // never the key itself. Operators seeing `none` here know the frontend will
  // fall back to browser recognition or typed messages.
  const speech = server.speechEnv;
  console.log(
    `[sangam] speech provider: ${speech.provider} (key configured: ${speech.deepgramApiKey ? "yes" : "no"}; model: ${speech.deepgramModel})`,
  );
  if (speech.provider === "none") {
    console.log(
      "[sangam] no server speech provider configured — clients use browser recognition or typed messages",
    );
  }
  console.log(
    "[sangam] in-memory rooms: state is lost on restart and not shared across instances",
  );

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`[sangam] ${signal} received, shutting down`);
    void server
      .close()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error("[sangam] shutdown error:", error);
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("[sangam] failed to start:", error);
  process.exit(1);
});
