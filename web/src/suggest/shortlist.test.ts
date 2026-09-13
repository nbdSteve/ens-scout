import { describe, expect, it } from 'vitest'
import { codePointLength } from '../format/text'
import { buildResults } from '../test/factory'
import { EXPLANATION_MAX_CHARS, SHORTLIST_MAX, SUGGESTIONS_MAX, THEME_MAX_CHARS } from './contract'
import {
  buildShortlist,
  deterministicReason,
  deterministicSuggestions,
  rankCandidates,
  shortlistNames,
  shortlistSuggestions,
} from './shortlist'
import { readTheme, vibeById, type Preference } from './vibes'

/**
 * The ranking both recommenders draw from.
 *
 * Every assertion here states an order outright rather than checking a property of one,
 * which is the whole reason the ranking is derived rather than sampled: the fallback has
 * to be a real answer a test can pin down, not an apology whose output nobody can
 * predict. Where an order is asserted, the scores behind it are worked out in the
 * comment above it, so a scoring change fails with something a reader can follow.
 */

function vibe(id: string): Preference {
  const found = vibeById(id)
  if (found === null) {
    throw new Error(`the ${id} vibe is gone, so this test is checking nothing`)
  }
  return { kind: 'vibe', vibe: found }
}

function theme(text: string): Preference {
  const { preference } = readTheme(text)
  if (preference === null) {
    throw new Error(`${JSON.stringify(text)} is no longer a usable theme`)
  }
  return preference
}

/** The names of a ranking, best first. */
function order(labels: readonly string[], preference: Preference): readonly string[] {
  return rankCandidates(buildResults(labels), preference).map((candidate) => candidate.result.name)
}

const NATURE = vibe('nature')

describe('ranking candidates', () => {
  /*
   * The four components, one per label, against the nature vibe:
   *
   *   moss   exact term (100) + every letter used (25) + 12 for four letters = 137
   *   ashen  'ash' inside it   (60) + every letter used (25) + 11 for five     =  96
   *   mossy  'moss' inside it  (60) + 'y' is in no term                        =  71
   *   zzzz   nothing at all, so 12 for being four letters                      =  12
   *
   * The gaps are wide enough that no tie-break can reorder them, which is the point of
   * asserting the whole order rather than only the winner.
   */
  it('puts an exact term first, then a substring, then length alone', () => {
    expect(order(['mossy', 'zzzz', 'ashen', 'moss'], NATURE)).toEqual([
      'moss.eth',
      'ashen.eth',
      'mossy.eth',
      'zzzz.eth',
    ])
  })

  /*
   * A two-letter term is inside a great many labels - `ax` is in `flax`, `axle`, and
   * `maxim` - so it counts only as a whole label. Without that the strongest signal in
   * the ranking would be the least informative one.
   */
  it('matches a two-letter term as a whole label and never inside one', () => {
    const short = vibe('short')
    const [flax] = rankCandidates(buildResults(['flax']), short)
    expect(flax?.matched).toEqual([])
    const [ax] = rankCandidates(buildResults(['ax']), short)
    expect(ax?.matched).toEqual(['ax'])
  })

  /* A label long enough to be informative counts when a term contains it, not only the
   * other way round: somebody asking for `port` is asking about `por` too. */
  it('matches a long enough label inside a term', () => {
    const [candidate] = rankCandidates(buildResults(['por']), vibe('built'))
    expect(candidate?.matched).toEqual(['port'])
  })

  /* Two letters is not long enough for that, for the same reason as above. */
  it('does not match a two-letter label inside a term', () => {
    const [candidate] = rankCandidates(buildResults(['po']), vibe('built'))
    expect(candidate?.matched).toEqual([])
  })

  /*
   * Scaled below one whole point, so it can only ever separate candidates whose real
   * components agree. `zzzz` scores 12 on length and `zzzzz` scores 11, and neither
   * matches anything, so the one-point gap has to survive whatever the two hashes are.
   */
  it('keeps the tie-break below the smallest real difference', () => {
    expect(order(['zzzzz', 'zzzz'], NATURE)).toEqual(['zzzz.eth', 'zzzzz.eth'])
  })

  /*
   * Derived from the label and the preference rather than sampled, which is what makes
   * the fallback the same answer on every device and every render.
   */
  it('gives the same order however the rows arrive', () => {
    const labels = ['moss', 'zzzz', 'kelpy', 'ashen', 'reed', 'bilk', 'loamy', 'silt']
    const once = order(labels, NATURE)
    expect(order([...labels].reverse(), NATURE)).toEqual(once)
    expect(order(labels, NATURE)).toEqual(once)
  })

  /*
   * Nothing here reads a status, an expiry, or a boundary. A ranking that moved when one
   * of those did would be classifying, which is the snapshot's job and never this
   * module's.
   */
  it('reads the label and nothing else off a result', () => {
    const labels = ['moss', 'zzzz', 'ashen', 'mossy']
    const available = rankCandidates(buildResults(labels, 'available'), NATURE)
    const grace = rankCandidates(buildResults(labels, 'grace-period'), NATURE)
    expect(grace.map((candidate) => candidate.result.name)).toEqual(
      available.map((candidate) => candidate.result.name),
    )
    expect(grace.map((candidate) => candidate.score)).toEqual(
      available.map((candidate) => candidate.score),
    )
  })

  it('does not reread candidate evidence while deriving the score', () => {
    const values = ['moss', 'reed']
    let reads = 0
    const terms = new Proxy(values, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/u.test(property)) {
          reads += 1
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const preference: Preference = { kind: 'theme', theme: 'moss reed', terms }
    const labels = ['moss', 'reed', 'zzzz']

    rankCandidates(buildResults(labels), preference)

    expect(reads).toBeLessThanOrEqual(values.length * (1 + 2 * labels.length))
  })
})

describe('building the shortlist', () => {
  const many = Array.from({ length: SHORTLIST_MAX + 8 }, (_, index) => `moss${String(index)}`)

  it('cuts to the bound and still reports everything that was in scope', () => {
    const shortlist = buildShortlist(buildResults(many), NATURE)
    expect(shortlist.candidates).toHaveLength(SHORTLIST_MAX)
    expect(shortlist.consideredCount).toBe(many.length)
  })

  /* The exact set an answer may name, fully qualified, in the shortlist's own order. */
  it('names the shortlist in its own order', () => {
    const shortlist = buildShortlist(buildResults(['zzzz', 'moss', 'mossy']), NATURE)
    expect(shortlistNames(shortlist)).toEqual(['moss.eth', 'mossy.eth', 'zzzz.eth'])
  })

  it('has nothing to offer when the filters admit nothing', () => {
    const shortlist = buildShortlist([], NATURE)
    expect(shortlist.candidates).toEqual([])
    expect(shortlist.consideredCount).toBe(0)
  })
})

describe('the sentences the deterministic recommender writes', () => {
  it('says a name is one of the vibe’s own words', () => {
    const [candidate] = rankCandidates(buildResults(['moss']), NATURE)
    expect(candidate).toBeDefined()
    expect(deterministicReason(candidate!, NATURE)).toBe('It is one of this vibe’s own words.')
  })

  it('says a name is a word the visitor typed', () => {
    const own = theme('moss reed')
    const [candidate] = rankCandidates(buildResults(['moss']), own)
    expect(deterministicReason(candidate!, own)).toBe('It is a word in your theme.')
  })

  it('quotes the term a name shares', () => {
    const [candidate] = rankCandidates(buildResults(['mossy']), NATURE)
    expect(deterministicReason(candidate!, NATURE)).toBe('Shares “moss” with the vibe you chose.')
  })

  /* `bilk` matches no term of the nature vibe, and every one of its letters is in one. */
  it('falls back to the letters when no term matched', () => {
    const [candidate] = rankCandidates(buildResults(['bilk']), NATURE)
    expect(candidate?.withinLetters).toBe(true)
    expect(deterministicReason(candidate!, NATURE)).toBe(
      'Every letter is one the vibe you chose uses. 4 letters.',
    )
  })

  it('says plainly when nothing matched at all', () => {
    const [candidate] = rankCandidates(buildResults(['zzzz']), NATURE)
    expect(candidate?.withinLetters).toBe(false)
    expect(deterministicReason(candidate!, NATURE)).toBe(
      'Nothing in the vibe you chose matched, so this is ranked on being 4 letters.',
    )
  })

  /*
   * A preference with no terms is a shape `readTheme` never returns - it reports
   * `no-terms` instead - so this is written by hand. It is still worth pinning: the claim
   * that every letter of a label is one the theme uses has to be checkable against a
   * theme that has letters, and an empty set would otherwise satisfy it vacuously for
   * every name on the page.
   */
  it('claims nothing about the letters of an empty theme', () => {
    const empty: Preference = { kind: 'theme', theme: '.', terms: [] }
    const [candidate] = rankCandidates(buildResults(['moss']), empty)
    expect(candidate?.withinLetters).toBe(false)
    expect(deterministicReason(candidate!, empty)).toBe(
      'Nothing in your theme matched, so this is ranked on being 4 letters.',
    )
  })
})

describe('the deterministic answer', () => {
  it('provides repository-owned text for every candidate the model may order', () => {
    const shortlist = buildShortlist(buildResults(['zzzz', 'moss', 'mossy']), NATURE)
    expect(shortlistSuggestions(shortlist, NATURE).map((suggestion) => suggestion.name)).toEqual(
      shortlistNames(shortlist),
    )
  })

  it('keeps the longest bounded theme explanation within the display ceiling', () => {
    const term = 'x'.repeat(THEME_MAX_CHARS)
    const suggestions = shortlistSuggestions(
      buildShortlist(buildResults([`${term}y`]), theme(term)),
      theme(term),
    )

    expect(suggestions).toHaveLength(1)
    expect(codePointLength(suggestions[0]?.reason ?? '')).toBeLessThanOrEqual(EXPLANATION_MAX_CHARS)
  })

  it('takes the top of the same ranking, bounded', () => {
    const labels = ['moss', 'ashen', 'mossy', 'zzzz', 'reed', 'silt', 'kelp', 'bilk']
    const shortlist = buildShortlist(buildResults(labels), NATURE)
    const suggestions = deterministicSuggestions(shortlist, NATURE)
    expect(suggestions).toHaveLength(SUGGESTIONS_MAX)
    expect(suggestions.map((suggestion) => suggestion.name)).toEqual(
      shortlistNames(shortlist).slice(0, SUGGESTIONS_MAX),
    )
  })

  it('carries the bare label and one sentence for each', () => {
    const shortlist = buildShortlist(buildResults(['moss']), NATURE)
    expect(deterministicSuggestions(shortlist, NATURE)).toEqual([
      { name: 'moss.eth', label: 'moss', reason: 'It is one of this vibe’s own words.' },
    ])
  })

  it('answers with nothing when the shortlist is empty', () => {
    expect(deterministicSuggestions(buildShortlist([], NATURE), NATURE)).toEqual([])
  })
})
