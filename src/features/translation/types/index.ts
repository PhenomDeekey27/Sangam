import type { LanguageCode } from "@/types";

/** Status of a single translation job. */
export type TranslationStatus =
  "queued" | "translating" | "complete" | "failed";

/** Machine-readable reasons a translation can fail. */
export type TranslationErrorCode =
  | "network"
  | "timeout"
  | "provider_error"
  | "unsupported_language"
  | "unknown";

/** A failed translation, with enough detail for an inline message. */
export interface TranslationError {
  readonly code: TranslationErrorCode;
  readonly message: string;
}

/**
 * Translation of one utterance, discriminated by `status` so error payloads
 * only exist on failure and text only exists on success.
 *
 * `unavailable` means no translation stage exists yet: the original text is
 * shown as-is, clearly labelled, rather than pretending a translation failed.
 */
export type TranslationState =
  | { readonly status: "queued" }
  | { readonly status: "translating" }
  | {
      readonly status: "complete";
      readonly text: string;
      readonly targetLanguage: LanguageCode;
    }
  | { readonly status: "failed"; readonly error: TranslationError }
  | { readonly status: "unavailable" };

/** The contract a translation provider must fulfil. */
export interface TranslationRequest {
  readonly text: string;
  readonly sourceLanguage: LanguageCode;
  readonly targetLanguage: LanguageCode;
}
