import type { LanguageCode } from "@/types";

/** A language offered by the two conversation selectors. */
export interface Language {
  readonly code: LanguageCode;
  /** English name, used for `aria-label`s and default copy. */
  readonly label: string;
  /** Endonym, shown as a secondary hint in the selector. */
  readonly native: string;
}

/** Languages Sangam ships selectors for. Codes are BCP-47. */
export const LANGUAGES: readonly Language[] = [
  { code: "en", label: "English", native: "English" },
  { code: "hi", label: "Hindi", native: "हिन्दी" },
  { code: "ta", label: "Tamil", native: "தமிழ்" },
  { code: "te", label: "Telugu", native: "తెలుగు" },
  { code: "bn", label: "Bengali", native: "বাংলা" },
  { code: "mr", label: "Marathi", native: "मराठी" },
  { code: "kn", label: "Kannada", native: "ಕನ್ನಡ" },
  { code: "ml", label: "Malayalam", native: "മലയാളം" },
  { code: "gu", label: "Gujarati", native: "ગુજરાતી" },
  { code: "pa", label: "Punjabi", native: "ਪੰਜਾਬੀ" },
  { code: "es", label: "Spanish", native: "Español" },
  { code: "fr", label: "French", native: "Français" },
  { code: "de", label: "German", native: "Deutsch" },
  { code: "pt", label: "Portuguese", native: "Português" },
  { code: "ar", label: "Arabic", native: "العربية" },
  { code: "ja", label: "Japanese", native: "日本語" },
  { code: "ko", label: "Korean", native: "한국어" },
  { code: "zh", label: "Chinese", native: "中文" },
];

/** Fallback when a URL carries no language preference. */
export const DEFAULT_SPOKEN_LANGUAGE: LanguageCode = "en";
export const DEFAULT_HEARD_LANGUAGE: LanguageCode = "ta";

/** Look up a language entry, or `undefined` for an unknown code. */
export function findLanguage(code: LanguageCode): Language | undefined {
  return LANGUAGES.find((language) => language.code === code);
}

/** English label for a code, falling back to the uppercased code. */
export function languageLabel(code: LanguageCode): string {
  return findLanguage(code)?.label ?? code.toUpperCase();
}

/** Endonym for a code, falling back to the code itself. */
export function languageNative(code: LanguageCode): string {
  return findLanguage(code)?.native ?? code;
}
