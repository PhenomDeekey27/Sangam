/**
 * Central Sarvam capability registry.
 *
 * Sangam speaks in BCP-47 *primary* subtags (`"ta"`); Sarvam's speech APIs
 * want full regional codes (`"ta-IN"`), and each Sarvam API supports a
 * slightly different language set. This module is the single place that
 * translates one into the other and answers "does Sarvam support this
 * language for this API, and with which model/voice?".
 *
 * Rules held here on purpose:
 * - No provider-specific code is ever hardcoded outside this module, so the
 *   room model, socket contract and frontend stay provider-agnostic.
 * - Every set is taken from the published Sarvam documentation; nothing is
 *   inferred. Where a model is documented to *not* cover a language, the
 *   registry says so instead of guessing.
 *
 * Sources (verified against docs.sarvam.ai, October 2026):
 * - STT: `POST /speech-to-text` (`saaras:v4`) `language_code` enum.
 * - Translation: `POST /translate` (`mayura:v1` / `sarvam-translate:v1`).
 * - TTS: `POST /text-to-speech` (`bulbul:v4-flash` voice catalog + the
 *   `language_code` enum shared with `bulbul:v3`).
 */

/** Sarvam STT/translation regional codes for Sangam's primary subtags. */
const REGIONAL_CODES: Readonly<Record<string, string>> = {
  en: "en-IN",
  hi: "hi-IN",
  bn: "bn-IN",
  gu: "gu-IN",
  kn: "kn-IN",
  ml: "ml-IN",
  mr: "mr-IN",
  od: "od-IN",
  pa: "pa-IN",
  ta: "ta-IN",
  te: "te-IN",
};

/**
 * Languages `saaras:v4` accepts on the REST transcript endpoint, as Sangam
 * codes. `od` is listed by Sarvam but Sangam does not offer Odia, so it can
 * never be requested from the room model and is deliberately absent here.
 */
export const SARVAM_STT_LANGUAGES: readonly string[] = [
  "en",
  "hi",
  "bn",
  "gu",
  "kn",
  "ml",
  "mr",
  "pa",
  "ta",
  "te",
];

/** Languages the translation API supports for both source and target. */
export const SARVAM_TRANSLATION_LANGUAGES: readonly string[] = [
  "en",
  "hi",
  "bn",
  "gu",
  "kn",
  "ml",
  "mr",
  "pa",
  "ta",
  "te",
];

/**
 * One compatible text-to-speech configuration for a Sangam language.
 * `model`, `voice` and `code` are all Sarvam-exact and documentation-backed.
 */
export interface SarvamVoice {
  readonly language: string;
  readonly model: string;
  readonly voice: string;
  /** BCP-47 regional code the TTS request must carry. */
  readonly code: string;
}

/**
 * Registry throttled to voices that are *published* for their model, so an
 * unsupported pair falls through to Gemini rather than being guessed.
 *
 * `bulbul:v4-flash` ships a persona catalog of `<name>_<language>_<style>`
 * voices that does not (yet) include Malayalam; Malayalam therefore uses the
 * documented `bulbul:v3` speaker `shubh`, exactly as the Voices guide
 * prescribes when v4 has no compatible voice for a target language.
 */
const VOICES: readonly SarvamVoice[] = [
  { language: "en", model: "bulbul:v4-flash", voice: "simran_en_conversation", code: "en-IN" },
  { language: "hi", model: "bulbul:v4-flash", voice: "ritu_hi_conversation", code: "hi-IN" },
  { language: "bn", model: "bulbul:v4-flash", voice: "arnab_bn_conversation", code: "bn-IN" },
  { language: "gu", model: "bulbul:v4-flash", voice: "pooja_gu_conversational", code: "gu-IN" },
  { language: "kn", model: "bulbul:v4-flash", voice: "chaitra_kn_conversation", code: "kn-IN" },
  { language: "mr", model: "bulbul:v4-flash", voice: "ishita_mr_conversational", code: "mr-IN" },
  { language: "pa", model: "bulbul:v4-flash", voice: "anand_pa_conversation", code: "pa-IN" },
  { language: "ta", model: "bulbul:v4-flash", voice: "gokul_ta_narration", code: "ta-IN" },
  { language: "te", model: "bulbul:v4-flash", voice: "kavitha_te_conversation", code: "te-IN" },
  // No published bulbul:v4-flash Malayalam persona: documented v3 fallback.
  { language: "ml", model: "bulbul:v3", voice: "shubh", code: "ml-IN" },
];

const VOICE_BY_LANGUAGE = new Map(
  VOICES.map((entry) => [entry.language, entry] as const),
);

/** Languages with a published Bulbul voice, as Sangam primary subtags. */
export const SARVAM_TTS_LANGUAGES: readonly string[] = VOICES.map(
  (entry) => entry.language,
);

/** Sarvam regional code for a Sangam primary subtag, or `null`. */
export function toSarvamLanguage(code: string | null | undefined): string | null {
  if (typeof code !== "string") return null;
  const primary = code.trim().toLowerCase().split("-")[0] ?? "";
  return REGIONAL_CODES[primary] ?? null;
}

/** Sangam primary subtag for a Sarvam regional code, or `null`. */
export function fromSarvamLanguage(code: unknown): string | null {
  if (typeof code !== "string") return null;
  const primary = code.trim().toLowerCase().split("-")[0] ?? "";
  return primary.length > 0 && REGIONAL_CODES[primary] !== undefined
    ? primary
    : null;
}

/** True when `saaras:v4` on the REST endpoint accepts this Sangam language. */
export function supportsSarvamStt(code: string): boolean {
  return languageIn(SARVAM_STT_LANGUAGES, code);
}

/** True when the translation API accepts this Sangam language on both sides. */
export function supportsSarvamTranslation(code: string): boolean {
  return languageIn(SARVAM_TRANSLATION_LANGUAGES, code);
}

/** The documented Bulbul voice for a language, or `null` when none exists. */
export function sarvamVoiceFor(code: string): SarvamVoice | null {
  const primary = primarySubtag(code);
  if (primary === null) return null;
  return VOICE_BY_LANGUAGE.get(primary) ?? null;
}

/** True when a compatible Bulbul model/voice exists for this language. */
export function supportsSarvamTts(code: string): boolean {
  return sarvamVoiceFor(code) !== null;
}

function primarySubtag(code: string): string | null {
  if (typeof code !== "string") return null;
  const primary = code.trim().toLowerCase().split("-")[0] ?? "";
  return primary.length > 0 ? primary : null;
}

function languageIn(set: readonly string[], code: string): boolean {
  const primary = primarySubtag(code);
  return primary !== null && set.includes(primary);
}
