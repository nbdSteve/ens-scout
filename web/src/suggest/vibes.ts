import { codePointLength } from '../format/text'
import { THEME_MAX_CHARS } from './contract'

/**
 * What a visitor can ask for.
 *
 * Either one of a fixed set of vibes or a short theme they type. Both reduce to the same
 * thing - a handful of terms - because both recommenders take terms and nothing else:
 * the deterministic one scores against them, and the model is shown them as the only
 * description of what was wanted. Keeping the two shapes convergent here is what stops
 * the built-in vibes becoming a path the fallback cannot serve.
 *
 * The vibes are a closed list rather than a suggestion box because they are also the
 * demonstrable case. A theme is whatever a visitor types, so nothing about the output
 * can be asserted from it; a vibe is a fixed input, so a test can state exactly which
 * names it should rank first and fail when that changes.
 */

export interface Vibe {
  readonly id: string
  /** The control's own label. */
  readonly label: string
  /** One line under it, saying what the vibe favours. */
  readonly description: string
  /**
   * The terms this vibe means. Lowercase, no punctuation, and deliberately short words:
   * they are matched against `.eth` labels, which are mostly four and five letters.
   */
  readonly terms: readonly string[]
}

export const VIBES: readonly Vibe[] = [
  {
    id: 'short',
    label: 'Short and sharp',
    description: 'The fewest letters, hard sounds, nothing ornamental.',
    terms: ['ax', 'ex', 'ix', 'ox', 'kit', 'jet', 'zap', 'bolt', 'flux', 'vex'],
  },
  {
    id: 'nature',
    label: 'Earth and water',
    description: 'Stone, weather, growing things.',
    terms: ['moss', 'fern', 'silt', 'reed', 'tide', 'dusk', 'loam', 'kelp', 'ash', 'bark'],
  },
  {
    id: 'cosmic',
    label: 'Sky and orbit',
    description: 'Stars, distance, things that turn.',
    terms: ['nova', 'orb', 'void', 'apex', 'halo', 'moon', 'dust', 'arc', 'ray', 'drift'],
  },
  {
    id: 'mythic',
    label: 'Old and told',
    description: 'Runes, sagas, things that were named before.',
    terms: ['rune', 'saga', 'omen', 'relic', 'oath', 'helm', 'raven', 'grail', 'myth', 'sage'],
  },
  {
    id: 'built',
    label: 'Made and wired',
    description: 'Tools, protocols, working parts.',
    terms: ['node', 'byte', 'sync', 'forge', 'anvil', 'proto', 'mesh', 'coil', 'gear', 'port'],
  },
]

const VIBE_BY_ID = new Map(VIBES.map((vibe) => [vibe.id, vibe]))

export function vibeById(id: string): Vibe | null {
  return VIBE_BY_ID.get(id) ?? null
}

/** A chosen vibe, or a theme a visitor typed. Never both. */
export type Preference =
  | { readonly kind: 'vibe'; readonly vibe: Vibe }
  | { readonly kind: 'theme'; readonly theme: string; readonly terms: readonly string[] }

/**
 * Why a typed theme was not usable, or null when it was.
 *
 * Reported rather than repaired, and reported from the field: the same reason a rejected
 * length bound is reported from its box in `state/useLengthDrafts.ts`. A theme silently
 * trimmed to nothing would leave the visitor looking at their own text and a ranking that
 * ignored it.
 */
export type ThemeProblem = 'empty' | 'too-long' | 'no-terms'

export interface ThemeReading {
  readonly preference: Preference | null
  readonly problem: ThemeProblem | null
}

/** As many terms as the longest built-in vibe carries, so neither input costs more. */
const THEME_TERMS_MAX = 10

/**
 * Reads a typed theme into terms.
 *
 * The split keeps letters and digits and drops everything else, which is what makes the
 * field a description rather than a channel: punctuation, newlines, and braces cannot
 * survive it, so nothing a visitor types reaches the prompt as structure. The terms are
 * lowercased because every `.eth` label is, and they are capped at the same count a vibe
 * carries so a long theme cannot make the prompt grow.
 */
export function readTheme(text: string): ThemeReading {
  const trimmed = text.trim()
  if (trimmed === '') {
    return { preference: null, problem: 'empty' }
  }
  if (codePointLength(trimmed) > THEME_MAX_CHARS) {
    return { preference: null, problem: 'too-long' }
  }
  const terms = [
    ...new Set(
      trimmed
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean),
    ),
  ].slice(0, THEME_TERMS_MAX)
  if (terms.length === 0) {
    return { preference: null, problem: 'no-terms' }
  }
  return { preference: { kind: 'theme', theme: trimmed, terms }, problem: null }
}

/** The terms a preference means, whichever shape it took. */
export function termsOf(preference: Preference): readonly string[] {
  return preference.kind === 'vibe' ? preference.vibe.terms : preference.terms
}

/**
 * A stable key for a preference.
 *
 * The deterministic recommender's tie-break is seeded from this, so the same preference
 * has to produce the same key across renders and across devices. A vibe's id is already
 * stable; a theme is keyed on its terms rather than its raw text, so two spellings that
 * read to the same terms rank identically.
 */
export function preferenceKey(preference: Preference): string {
  return preference.kind === 'vibe'
    ? `vibe:${preference.vibe.id}`
    : `theme:${[...termsOf(preference)].sort().join(',')}`
}

/**
 * What a visitor asked for, in their own words, for a sentence that repeats it back.
 *
 * For the screen only. A theme reads back as the text that was typed, which is the whole
 * point of repeating it, and that text still holds whatever punctuation it was typed with.
 * `preferenceDescription` is the one that may be built into a prompt.
 */
export function preferenceLabel(preference: Preference): string {
  return preference.kind === 'vibe' ? preference.vibe.label : preference.theme
}

/**
 * The same preference as something safe to build a prompt from.
 *
 * A vibe describes itself with its own label, which is a fixed literal this repository
 * owns. A theme describes itself with its terms and never with the text it was typed as,
 * because that text is the one string on this page a visitor chooses freely: `readTheme`
 * strips punctuation, braces, and newlines on the way to terms, and reading the raw text
 * back out would put all three into the prompt and undo the split. The terms carry the
 * meaning anyway, so nothing is lost by saying it this way.
 *
 * That is not the shortlist rule - the schema's `enum` and `parse.ts` are what keep a name
 * inside the shortlist, and neither depends on this. It is the narrower promise that a
 * visitor cannot address the model in structure: the model receives only the resulting
 * bounded terms.
 */
export function preferenceDescription(preference: Preference): string {
  return preference.kind === 'vibe' ? preference.vibe.label : termsOf(preference).join(', ')
}
