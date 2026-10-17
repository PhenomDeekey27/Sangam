/**
 * Verified-shape parsers for the unofficial Google Translate endpoints.
 *
 * Every recognized shape below was captured live against the fixed sentence
 * `Hello, how are you?` (en → ta); nothing is assumed beyond these captures
 * and the endpoint's own documented history. Redacted live captures:
 *
 * - Endpoint A (`translate_a/t?client=dict-chrome-ex`), a plain array of
 *   translated segment strings, one per array element:
 *
 *       ["வணக்கம், நலமா?"]
 *
 * - Endpoint B (`translate_a/single?client=gtx&dt=t`), nested per-segment
 *   segments; row[0] is a segment translation, row[1] its source text, and
 *   root[2] the detected source language (hashes/columns elided):
 *
 *       [[["வணக்கம், நலமா?", "Hello, how are you?", null, null, 3, ...]],
 *        null, "en", null, null, null, null, []]
 *
 * - Endpoint B, three sentences: segments keep their original order and
 *   carry trailing spaces that must be joined without duplication:
 *
 *       [[["காலை வணக்கம். ", "Good morning. ", ...]],
 *        [["உங்கள் நாள் எப்படி இருக்கிறீர்கள்? ", "How was your day? ", ...]],
 *        [["நாளை சந்திப்போம்.", "See you tomorrow.", ...]],
 *        null, "en", ...]
 *
 * The legacy `{sentences: [{trans}], src}` object shape (endpoint A's older
 * form) is still recognized as a defense against shape drift — these
 * endpoints are undocumented and have changed shape before, which is exactly
 * how an HTTP 200 once came to mean "no translation parsed".
 *
 * Nothing here trusts structure blindly: anything that is not one of these
 * shapes, or yields no text, is a rejection — never a translation.
 */

/** Which response shape a body matched (or `"unrecognized"` on a reject). */
export type GoogleResponseFormat =
  | "segment_list"
  | "sentence_list"
  | "sentence_object"
  | "unrecognized";

/** Why a parsed-but-unusable body was refused. Echo detection is upstream. */
export type GoogleResponseRejection = "empty" | "unexpected";

/** Segments extracted from one recognized response shape. */
export interface GoogleResponseSegments {
  readonly format: Exclude<GoogleResponseFormat, "unrecognized">;
  /** Translated segments in their original order. */
  readonly parts: readonly string[];
  /** Detected source language when the endpoint reports one, else null. */
  readonly detectedSource: string | null;
}

export type GoogleResponseParse =
  | { readonly ok: true; readonly segments: GoogleResponseSegments }
  | {
      readonly ok: false;
      readonly format: GoogleResponseFormat;
      readonly rejection: GoogleResponseRejection;
    };

/**
 * A segment count no real utterance could exceed; larger arrays are treated
 * as an unexpected shape rather than a translation soup.
 */
const MAX_PARTS = 128;

/**
 * Extract translated segments from a Google Translate response body. The
 * result must be joined with `" ".replace(/\s+/g, " ")` upstream so that
 * segments carrying their own trailing spaces do not gain doubled spaces.
 */
export function parseGoogleTranslationResponse(
  body: unknown,
): GoogleResponseParse {
  if (Array.isArray(body)) return parseArrayBody(body);
  if (isRecord(body)) return parseObjectBody(body);
  return reject("unrecognized", "unexpected");
}

/** Route an array body between the two verified array shapes. */
function parseArrayBody(body: readonly unknown[]): GoogleResponseParse {
  const first = body[0];
  if (Array.isArray(first) && body.length >= 1) {
    return parseSegmentRows(first, body);
  }
  return parseSentenceList(body);
}

/**
 * Endpoint B (`gtx`, `dt=t`): `root[0]` holds segment rows; row[0] is the
 * translation, row[1] the original text, root[2] the detected source.
 * Non-null rows must be arrays carrying a usable translation at [0] —
 * anything else (dictionary entries, error rows, inverted rows) is rejected.
 */
function parseSegmentRows(
  rows: readonly unknown[],
  root: readonly unknown[],
): GoogleResponseParse {
  const parts: string[] = [];
  for (const row of rows) {
    if (row === null || row === undefined) continue;
    if (!Array.isArray(row)) return reject("segment_list", "unexpected");
    const trans = row[0];
    if (typeof trans !== "string" || trans.trim() === "") {
      return reject("segment_list", "unexpected");
    }
    parts.push(trans);
  }
  if (parts.length === 0) return reject("segment_list", "empty");
  if (parts.length > MAX_PARTS) return reject("segment_list", "unexpected");
  const detected = root[2];
  return {
    ok: true,
    segments: {
      format: "segment_list",
      parts,
      detectedSource:
        typeof detected === "string" && detected.trim() !== ""
          ? detected
          : null,
    },
  };
}

/**
 * Endpoint A today: a flat array of translated strings (live shape). Every
 * non-null element must be a string; mixed elements mean the dictionary
 * format arrived, which does not carry sentence translations.
 */
function parseSentenceList(
  body: readonly unknown[],
): GoogleResponseParse {
  const parts: string[] = [];
  for (const element of body) {
    if (element === null || element === undefined) continue;
    if (typeof element !== "string") {
      return reject("sentence_list", "unexpected");
    }
    if (element.trim() !== "") parts.push(element);
  }
  if (parts.length === 0) return reject("sentence_list", "empty");
  if (parts.length > MAX_PARTS) return reject("sentence_list", "unexpected");
  return {
    ok: true,
    segments: { format: "sentence_list", parts, detectedSource: null },
  };
}

/**
 * Legacy object shape: `{sentences: [{trans}, ...], src}`. Strict on entry
 * structure (each non-null entry must be a record with a string `trans`);
 * any drift is rejected rather than guessed at.
 */
function parseObjectBody(body: Record<string, unknown>): GoogleResponseParse {
  const sentences = body.sentences;
  if (!Array.isArray(sentences)) {
    return { ok: false, format: "unrecognized", rejection: "unexpected" };
  }
  const parts: string[] = [];
  for (const entry of sentences) {
    if (entry === null || entry === undefined) continue;
    if (!isRecord(entry) || typeof entry.trans !== "string") {
      return { ok: false, format: "unrecognized", rejection: "unexpected" };
    }
    if (entry.trans.trim() !== "") parts.push(entry.trans);
  }
  if (parts.length === 0 || parts.length > MAX_PARTS) {
    return { ok: false, format: "sentence_object", rejection: "empty" };
  }
  const src = body.src;
  return {
    ok: true,
    segments: {
      format: "sentence_object",
      parts,
      detectedSource:
        typeof src === "string" && src.trim() !== "" ? src : null,
    },
  };
}

function reject(
  format: GoogleResponseFormat,
  rejection: GoogleResponseRejection,
): GoogleResponseParse {
  return { ok: false, format, rejection };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
