import { createSangamServer } from "./app.js";
import { loadEnv } from "./config/env.js";
import { SARVAM_DEFAULT_TTS_MODEL } from "./tts/sarvam-provider.js";

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
    `[sangam] speech provider: ${speech.provider} ` +
      `(sarvam key configured: ${speech.sarvamApiKey ? "yes" : "no"}; model: ${speech.sarvamModel}` +
      ` | deepgram key configured: ${speech.deepgramApiKey ? "yes" : "no"}; model: ${speech.deepgramModel})`,
  );
  if (speech.provider === "none") {
    console.log(
      "[sangam] no server speech provider configured — clients use browser recognition or typed messages",
    );
  }
  const translation = server.translationEnv;
  console.log(
    `[sangam] translation primary: ${translation.primary ?? "none"}` +
      `; fallback: ${translation.fallback ?? "none"}` +
      ` (sarvam key configured: ${translation.sarvamApiKey ? "yes" : "no"}; model: ${translation.sarvamModel}` +
      ` | gemini key configured: ${translation.apiKey ? "yes" : "no"}; model: ${translation.model})`,
  );
  if (!translation.primary) {
    console.log(
      "[sangam] no translation provider configured — transcripts stay untranslated",
    );
  }
  const tts = server.ttsEnv;
  console.log(
    `[sangam] playback provider: ${tts.provider ?? "none"}` +
      ` (sarvam key configured: ${tts.sarvamApiKey ? "yes" : "no"}; model: ${tts.sarvamModel ?? SARVAM_DEFAULT_TTS_MODEL}` +
      ` | gemini key configured: ${tts.apiKey ? "yes" : "no"}; model: ${tts.model}; voice: ${tts.voice})`,
  );
  if (!tts.provider) {
    console.log(
      "[sangam] no text-to-speech provider configured — listeners read translations as text only",
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
