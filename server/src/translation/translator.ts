/**
 * Machine-translation contracts. The rest of the server depends on the
 * `Translator` interface, never on a concrete vendor — provider specifics
 * live in the adapter modules beside this file.
 */

/** One translation job: finalized utterance text with known languages. */
export interface TranslationRequest {
  /** Finalized utterance text (never an interim line). */
  readonly text: string;
  /** BCP-47 source code, e.g. `"fr"`. */
  readonly sourceLanguage: string;
  /** BCP-47 target code, e.g. `"pa"`. */
  readonly targetLanguage: string;
}

/** A completed translation. */
export interface TranslationResult {
  readonly text: string;
  readonly targetLanguage: string;
}

/** Machine-readable provider failure reasons (never shown verbatim). */
export type TranslationFailureCode =
  "network" | "timeout" | "rate_limited" | "unsupported" | "auth" | "unknown";

/** A provider failure. `detail` is server-log-only and never hits the wire. */
export class TranslationProviderError extends Error {
  readonly code: TranslationFailureCode;
  /** Upstream HTTP status when the failure came from an HTTP round trip. */
  readonly httpStatus: number | null;

  constructor(
    code: TranslationFailureCode,
    detail: string,
    httpStatus?: number | null,
  ) {
    // The message stays server-side; clients get a mapped, safe message.
    super(detail);
    this.name = "TranslationProviderError";
    this.code = code;
    this.httpStatus =
      typeof httpStatus === "number" &&
      Number.isInteger(httpStatus) &&
      httpStatus > 0
        ? httpStatus
        : null;
  }
}

/** The single call a translation vendor must fulfil. */
export interface Translator {
  translate(request: TranslationRequest): Promise<TranslationResult>;
}
