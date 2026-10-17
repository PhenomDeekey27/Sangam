/**
 * Ordered speech-provider chain.
 *
 * Sangam prefers Sarvam Saaras and keeps Deepgram as the fallback, but a
 * *language* also decides the route: neither vendor covers the whole language
 * list, so the chain advertises the union of its members' languages and picks,
 * per session, the first member that accepts the requested language.
 *
 * The chain deliberately does not own retry policy. A member that can fall
 * back internally (Sarvam replays its buffered turn into Deepgram) wires that
 * itself in `provider-factory`, so a failure still produces exactly one final
 * transcript rather than two competing ones.
 */
import type { SpeechProvider } from "./provider.js";

/**
 * Build a provider that routes each session to the first member accepting the
 * language. Returns the single member untouched when there is only one, so
 * existing single-provider behavior (and its capabilities) is preserved.
 */
export function createChainedSpeechProvider(
  entries: readonly SpeechProvider[],
): SpeechProvider | null {
  const members = entries.filter((entry) => entry.id !== "none");
  if (members.length === 0) return null;
  if (members.length === 1) return members[0] ?? null;
  const preferred = members[0] as SpeechProvider;
  return {
    id: preferred.id,
    // The server pipeline always accepts a streamed turn; whether the vendor
    // streams or batches it is reported by `interim`.
    streaming: true,
    interim: members.some((member) => member.interim),
    languages: unionLanguages(members),
    open(options) {
      return selectMember(members, options.language).open(options);
    },
  };
}

/** The member that will serve this language; the preferred one as a last resort. */
export function selectMember(
  members: readonly SpeechProvider[],
  language: string,
): SpeechProvider {
  const match = members.find(
    (member) =>
      member.languages.length === 0 || member.languages.includes(language),
  );
  return match ?? (members[0] as SpeechProvider);
}

function unionLanguages(members: readonly SpeechProvider[]): readonly string[] {
  const seen = new Set<string>();
  for (const member of members) {
    for (const language of member.languages) seen.add(language);
  }
  return [...seen];
}
