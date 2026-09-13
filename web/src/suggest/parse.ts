import { wireReaders } from '../wire/read'
import { SUGGESTIONS_MAX } from './contract'
import type { Suggestion } from './shortlist'

/**
 * Reading what the model produced.
 *
 * This is the boundary between a generated string and anything the page shows, and it is
 * fail-closed in the same way the two wire parsers are: a document that does not match is
 * refused whole, never repaired and never partially used. What is different here is that
 * the producer is a 360M model rather than a service in this repository, so a refusal is
 * ordinary rather than exceptional - which is exactly why the fallback in
 * `shortlist.ts` has to be a real answer.
 *
 * The one rule everything else serves: a name may appear in the output only if it was in
 * the shortlist that was supplied. The model is shown a fixed list and asked to choose
 * from it, so a name it did not receive is either a hallucination or a label from its
 * training data, and in both cases it is a name this page has no snapshot record of and
 * therefore nothing true to say about. Membership is checked against the supplied set by
 * exact string equality; it is not re-derived, re-normalized, or matched loosely.
 *
 * Prose around the JSON is a refusal rather than something to strip. The engine is asked
 * for a JSON object and constrains decoding to one, so a fenced block or a preamble means
 * the constraint was not applied - and a parser that learned to skip past commentary would
 * be a parser that accepts a document the pinned configuration cannot produce.
 */

/** Raised for any answer this build will not use. */
export class SuggestFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SuggestFormatError'
  }
}

function fail(message: string): never {
  throw new SuggestFormatError(message)
}

const { asRecord, asArray, asString, asLabel } = wireReaders(fail)

/** The only key the document may carry, and the only key each pick may carry. */
const DOCUMENT_KEYS = ['picks'] as const
const PICK_KEYS = ['name'] as const

/**
 * Characters a model-supplied string may not contain.
 *
 * The C0, DEL, and C1 ranges, plus the bidirectional formatting characters. React escapes
 * markup, so nothing here is about injection; it is about refusing text before any shape
 * check, trimming, normalization, or display could reinterpret it.
 */
// Matching control characters is the intent here, so the rule against them is waived.
const FORBIDDEN_IN_MODEL_STRING =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      // The key is quoted and its value is not. A model that echoed part of a prompt into
      // a field name is a refusal worth naming; the value could be anything at all.
      fail(`${what} has an unexpected field ${JSON.stringify(key)}`)
    }
  }
}

/**
 * Parses one generated answer against the shortlist it was generated from.
 *
 * `allowed` is the exact set of repository-owned suggestions corresponding to the
 * shortlist the model was shown. The answer can select and order those values, but it
 * cannot supply any text that reaches the screen.
 */
export function parseSuggestions(
  text: string,
  allowed: readonly Suggestion[],
): readonly Suggestion[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // The thrown parse error quotes the offending input, so it is dropped rather than
    // wrapped. Everything a caller does with this is choose a fixed sentence.
    fail('the answer is not JSON')
  }

  const document = asRecord(parsed, 'the answer')
  assertExactKeys(document, DOCUMENT_KEYS, 'the answer')
  const picks = asArray(document.picks, 'the answer’s picks')
  if (picks.length === 0) {
    fail('the answer names no picks')
  }
  if (picks.length > SUGGESTIONS_MAX) {
    fail(`the answer names more than ${String(SUGGESTIONS_MAX)} picks`)
  }

  const permitted = new Map<string, Suggestion>(
    allowed.map((suggestion) => [suggestion.name, suggestion] as const),
  )
  const seen = new Set<string>()
  return picks.map((entry, index) => {
    const what = `pick ${String(index + 1)}`
    const pick = asRecord(entry, what)
    assertExactKeys(pick, PICK_KEYS, what)

    const name = asString(pick.name, `${what}’s name`)
    if (FORBIDDEN_IN_MODEL_STRING.test(name)) {
      fail(`${what}’s name contains characters that cannot be displayed`)
    }
    // `asLabel` re-checks the shape and yields the bare label. Membership is what makes
    // the name usable; the shape check makes malformed qualified names a refusal before
    // the caller's shortlist is consulted.
    asLabel(name, `${what}’s name`)
    const suggestion = permitted.get(name)
    if (suggestion === undefined) {
      fail(`${what} names a name that was not offered`)
    }
    if (seen.has(name)) {
      fail(`${what} repeats a name`)
    }
    seen.add(name)

    return suggestion
  })
}
