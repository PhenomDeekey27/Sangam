/**
 * Text-to-speech provider boundary (Stage 6).
 *
 * Mirrors the speech-to-text boundary in `../speech/provider.ts`: the server
 * owns synthesis so no credential or vendor SDK ever reaches the browser.
 * A provider turns one completed *translation* into self-describing audio
 * (a complete WAV container, playable directly by an `<audio>` element).
 * Concrete adapters (`mock`, `gemini`) live beside this file; nothing else in
 * the app knows which vendor is in use.
 */

/** One synthesis job: finalized translation text with its target language. */
export interface TtsRequest {
  /** Translated text exactly as stored on the transcript row. */
  readonly text: string;
  /** BCP-47 primary subtag the audio should be spoken in, e.g. `"ta"`. */
  readonly language: string;
}

/** A completed synthesis. */
export interface TtsResult {
  /** Complete audio container bytes (WAV), ready for playback and relay. */
  readonly audio: Buffer;
  /** MIME type of `audio` as delivered on the wire, e.g. `"audio/wav"`. */
  readonly mimeType: string;
}

/** Machine-readable provider failure reasons (never shown verbatim). */
export type TtsFailureCode =
  | "network"
  | "timeout"
  | "rate_limited"
  | "unsupported"
  | "auth"
  | "unknown";

/** A provider failure. `detail` is server-log-only and never hits the wire. */
export class TtsProviderError extends Error {
  readonly code: TtsFailureCode;
  /** Upstream HTTP status when the failure came from an HTTP round trip. */
  readonly httpStatus: number | null;

  constructor(code: TtsFailureCode, detail: string, httpStatus?: number | null) {
    // The message stays server-side; the listener only ever reads the
    // translated text row, which this failure never touches.
    super(detail);
    this.name = "TtsProviderError";
    this.code = code;
    this.httpStatus =
      typeof httpStatus === "number" && Number.isInteger(httpStatus) && httpStatus > 0
        ? httpStatus
        : null;
  }
}

/** Which vendor id a provider reports. `none` never synthesizes. */
export type TtsProviderId = "sarvam" | "gemini" | "mock" | "none";

/** One text-to-speech engine. */
export interface TtsProvider {
  readonly id: TtsProviderId;
  /**
   * Languages this engine accepts (BCP-47 primary subtags). An empty list
   * means "auto-detects every language Sangam supports".
   */
  readonly languages: readonly string[];
  /**
   * Optional language-aware routing for a chain: returns the member that
   * would serve this language first, or `null` when no member can. A provider
   * without `select` is asked directly for every language.
   */
  readonly select?: (language: string) => TtsProvider | null;
  /**
   * Optional stable identity (engine + model + voice) folded into the
   * playback cache key, so audio produced by one engine is never served as
   * another engine's output.
   */
  readonly cacheTag?: string;
  /**
   * Synthesize one utterance-sized translation. Resolves with a complete
   * audio container or rejects with `TtsProviderError` — never both-neither.
   */
  readonly synthesize: (request: TtsRequest) => Promise<TtsResult>;
}
