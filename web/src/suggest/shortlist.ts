import { codePointLength, codePoints, compareNames } from '../format/text'
import { fnv1a } from '../constellation/compose'
import type { SnapshotResult } from '../snapshot/types'
import { EXPLANATION_MAX_CHARS, SHORTLIST_MAX, SUGGESTIONS_MAX } from './contract'
import { preferenceKey, termsOf, type Preference } from './vibes'

/**
 * The shortlist, and the recommender that needs no model.
 *
 * One scoring function serves both paths, which is the point of putting them in one
 * module. The model is shown the top `SHORTLIST_MAX` of this ranking and may reorder them;
 * the deterministic recommender takes the top `SUGGESTIONS_MAX` of the same ranking. Both
 * paths use the repository-owned explanation derived here, so generated prose never
 * becomes a claim on screen.
 *
 * Everything here is pure and stable. The same snapshot, the same filters, and the same
 * preference produce the same shortlist and the same fallback ranking on every device and
 * on every render, which is what makes the fallback a real answer rather than an
 * apology, and what lets a test state the expected order outright.
 *
 * Nothing here judges a lifecycle. It reads `label` and nothing else off a result: the
 * status, the expiry, and the boundaries stay whatever the snapshot published, and
 * whether a name may be acted on is still decided only by `verify/gate.ts`.
 */

/** One scored candidate, with the evidence its sentence is written from. */
export interface Scored {
  readonly result: SnapshotResult
  readonly score: number
  /** Terms of the preference this label actually shares text with, in prompt order. */
  readonly matched: readonly string[]
  /** True when every letter of the label appears somewhere in the preference's terms. */
  readonly withinLetters: boolean
}

type ScoringEvidence = Pick<Scored, 'matched' | 'withinLetters'>

/**
 * Shortest term worth matching as a substring.
 *
 * Two letters match almost everything - `ax` is inside `flax`, `axle`, and `maxim` - so a
 * short term counts only when it is the whole label. Without this the strongest signal
 * would be the least informative one.
 */
const MIN_SUBSTRING_TERM = 3

/** A label at or under this length gets the largest share of the length bonus. */
const SHORT_LABEL_CEILING = 16

const EXACT_SCORE = 100
const SUBSTRING_SCORE = 60
const LETTERS_SCORE = 25

/**
 * The tie-break between two otherwise equal candidates.
 *
 * A hash of the label and the preference, scaled below one so it can only separate
 * candidates whose real components agree - a stable pseudo-random order rather than
 * alphabetical clumping, and the same order on every device because it is derived rather
 * than sampled.
 */
function tieBreak(label: string, key: string): number {
  // 2**32, so the result is in [0, 1) and cannot reach the next whole point of score.
  return fnv1a(`${label}|${key}`) / 4_294_967_296
}

function scoreFromEvidence(label: string, found: ScoringEvidence): number {
  let score = 0
  for (const term of found.matched) {
    score += term === label ? EXACT_SCORE : SUBSTRING_SCORE
  }
  if (found.withinLetters) {
    score += LETTERS_SCORE
  }
  return score + Math.max(0, SHORT_LABEL_CEILING - codePointLength(label))
}

function evidence(label: string, terms: readonly string[]): ScoringEvidence {
  const matched = terms.filter(
    (term) =>
      term === label ||
      (term.length >= MIN_SUBSTRING_TERM &&
        (label.includes(term) || (label.length >= MIN_SUBSTRING_TERM && term.includes(label)))),
  )
  const available = new Set(codePoints(terms.join('')))
  const letters = codePoints(label)
  return {
    matched,
    // An empty preference cannot contain anything, so the claim is false rather than
    // vacuously true: a sentence saying every letter is one the theme uses has to be
    // checkable against a theme that has letters.
    withinLetters: available.size > 0 && letters.every((letter) => available.has(letter)),
  }
}

/**
 * Scores and orders every candidate, best first.
 *
 * `compareNames` is the final tie-break even though the hash almost always separates two
 * candidates first. That is deliberate: it makes the order total, so it cannot depend on
 * the sort implementation, and it is the snapshot's own byte-wise order rather than the
 * browser's UTF-16 one.
 */
export function rankCandidates(
  results: readonly SnapshotResult[],
  preference: Preference,
): readonly Scored[] {
  const terms = termsOf(preference)
  const key = preferenceKey(preference)
  const scored = results.map<Scored>((result) => {
    const found = evidence(result.label, terms)
    return {
      result,
      score: scoreFromEvidence(result.label, found) + tieBreak(result.label, key),
      ...found,
    }
  })
  return scored.sort((left, right) =>
    left.score === right.score
      ? compareNames(left.result.name, right.result.name)
      : right.score - left.score,
  )
}

export interface Shortlist {
  /** The candidates either recommender may choose from, best first. */
  readonly candidates: readonly Scored[]
  /** How many names were in scope before the shortlist was cut to its bound. */
  readonly consideredCount: number
}

/**
 * The exact set a recommender may draw from.
 *
 * `results` is already filtered: `App` passes the rows the visitor's own view, search,
 * status, length, and list filters admit, so the shortlist narrows what they chose rather
 * than reaching past it. That is also the only control over which statuses can be
 * suggested, which is why it is the filters and not a rule here: a visitor who wants only
 * available names sets that filter, and the shortlist follows.
 */
export function buildShortlist(
  results: readonly SnapshotResult[],
  preference: Preference,
): Shortlist {
  const ranked = rankCandidates(results, preference)
  return { candidates: ranked.slice(0, SHORTLIST_MAX), consideredCount: results.length }
}

/** The names in a shortlist, in its own order. The exact set a model answer may name. */
export function shortlistNames(shortlist: Shortlist): readonly string[] {
  return shortlist.candidates.map((candidate) => candidate.result.name)
}

/**
 * The reason the deterministic recommender gives for one name.
 *
 * Fixed templates, chosen by which component of the score actually contributed, so the
 * sentence is a statement about this ranking rather than a guess dressed as one. The
 * quoted term is a term from the preference, which is either a built-in vibe's word or
 * something the visitor typed and this page reduced to letters and digits.
 */
export function deterministicReason(candidate: Scored, preference: Preference): string {
  const what = preference.kind === 'vibe' ? 'the vibe you chose' : 'your theme'
  const [term] = candidate.matched
  if (term !== undefined) {
    return term === candidate.result.label
      ? `It is ${what === 'your theme' ? 'a word in your theme' : 'one of this vibe’s own words'}.`
      : `Shares “${term}” with ${what}.`
  }
  const letters = codePointLength(candidate.result.label)
  if (candidate.withinLetters) {
    return `Every letter is one ${what} uses. ${String(letters)} letters.`
  }
  return `Nothing in ${what} matched, so this is ranked on being ${String(letters)} letters.`
}

export interface Suggestion {
  readonly name: string
  readonly label: string
  /** One repository-owned sentence derived from the candidate's scoring evidence. */
  readonly reason: string
}

function suggestion(candidate: Scored, preference: Preference): Suggestion {
  const reason = deterministicReason(candidate, preference)
  if (codePointLength(reason) > EXPLANATION_MAX_CHARS) {
    throw new Error('a repository-owned suggestion explanation exceeds its display bound')
  }
  return {
    name: candidate.result.name,
    label: candidate.result.label,
    reason,
  }
}

/** Every candidate the model may order, carrying only repository-owned display text. */
export function shortlistSuggestions(
  shortlist: Shortlist,
  preference: Preference,
): readonly Suggestion[] {
  return shortlist.candidates.map((candidate) => suggestion(candidate, preference))
}

/** The fallback answer: the top of the same ranking, with its own honest sentences. */
export function deterministicSuggestions(
  shortlist: Shortlist,
  preference: Preference,
): readonly Suggestion[] {
  return shortlistSuggestions(shortlist, preference).slice(0, SUGGESTIONS_MAX)
}
