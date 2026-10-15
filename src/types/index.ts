/**
 * BCP-47 language tag (for example `"en"`, `"ta"`, `"hi"`).
 *
 * Lives at the app root because speech recognition, conversation
 * utterances, and translation pairs all reference it — no single feature
 * owns it.
 */
export type LanguageCode = string;
