/**
 * Ordered text-to-speech chain.
 *
 * Sangam prefers Sarvam Bulbul and keeps Gemini TTS as the fallback, so a
 * completed translation is spoken by the best-configured provider that accepts
 * its language. Two independent gates:
 *
 * - Language routing (`select`): the first member whose catalog covers the
 *   language. Sarvam's Bulbul catalog is Indic-only; non-Indic languages route
 *   straight to Gemini.
 * - Failure fallback (`synthesize`): if the preferred member errors on this
 *   text, the next accepting member is attempted, so one vendor outage never
 *   turns a translated line silent.
 *
 * The chain reports the union of its members' languages and a combined
 * `cacheTag`, so the playback cache never serves one engine's audio as
 * another's.
 */
import {
  TtsProviderError,
  type TtsProvider,
  type TtsRequest,
  type TtsResult,
} from "./provider.js";

/** Build a chain; `null` when no member can synthesize. */
export function createChainedTtsProvider(
  entries: readonly (TtsProvider | null)[],
): TtsProvider | null {
  const members = entries.filter(
    (entry): entry is TtsProvider => entry !== null && entry.id !== "none",
  );
  if (members.length === 0) return null;
  if (members.length === 1) return members[0] as TtsProvider;
  return {
    id: (members[0] as TtsProvider).id,
    languages: unionLanguages(members),
    cacheTag: members
      .map((member) => member.cacheTag ?? member.id)
      .join("|"),
    select(language: string): TtsProvider | null {
      return acceptingMembers(members, language)[0] ?? null;
    },
    async synthesize(request: TtsRequest): Promise<TtsResult> {
      const accepting = acceptingMembers(members, request.language ?? "");
      if (accepting.length === 0) {
        throw new TtsProviderError(
          "unsupported",
          `no playback provider accepts ${request.language || "?"}`,
        );
      }
      let lastError: unknown = null;
      for (const member of accepting) {
        try {
          return await member.synthesize(request);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new TtsProviderError("unknown", "playback chain failed");
    },
  };
}

/** Members that accept a language, in chain order (empty list = accepts all). */
export function acceptingMembers(
  members: readonly TtsProvider[],
  language: string,
): TtsProvider[] {
  return members.filter(
    (member) =>
      member.languages.length === 0 || member.languages.includes(language),
  );
}

function unionLanguages(members: readonly TtsProvider[]): readonly string[] {
  const seen = new Set<string>();
  for (const member of members) {
    for (const language of member.languages) seen.add(language);
  }
  return [...seen];
}
