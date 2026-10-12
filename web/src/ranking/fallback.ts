import type { SnapshotResult } from '../snapshot/types'
import {
  FACETS,
  MAX_OG_SCORE,
  MIN_OG_SCORE,
  type FeatureAllowlist,
  type FeaturedName,
} from './contract'

const COMMON_BIGRAMS = new Set([
  'ai',
  'al',
  'an',
  'ar',
  'as',
  'at',
  'be',
  'ch',
  'co',
  'de',
  'ea',
  'ed',
  'en',
  'er',
  'es',
  'ha',
  'he',
  'hi',
  'ic',
  'in',
  'io',
  'is',
  'it',
  'le',
  'li',
  'll',
  'ma',
  'me',
  'mo',
  'nd',
  'ne',
  'ng',
  'nt',
  'of',
  'om',
  'on',
  'or',
  'ou',
  'ra',
  're',
  'ri',
  'ro',
  'se',
  'si',
  'st',
  'te',
  'th',
  'ti',
  'to',
  'ur',
  've',
])

const AWKWARD_CLUSTERS = new Set([
  'aa',
  'ae',
  'ao',
  'eu',
  'ii',
  'iu',
  'jj',
  'qj',
  'qx',
  'qy',
  'qz',
  'uu',
  'ww',
  'xq',
  'xx',
  'zq',
  'zx',
  'zz',
])

const RESIDUE_SUFFIXES: readonly (readonly [string, number])[] = [
  ['ings', 12],
  ['ers', 10],
  ['ies', 9],
  ['ied', 9],
  ['est', 7],
  ['ism', 6],
  ['ist', 6],
  ['ous', 6],
  ['ing', 8],
  ['ed', 6],
  ['es', 5],
  ['er', 4],
  ['ly', 5],
  ['al', 3],
  ['ic', 3],
  ['s', 4],
]

const MAX_RECOGNIZABILITY = 25
const MAX_MEMORABILITY = 20
const MAX_SEMANTIC_DENSITY = 15
const MAX_DISTINCTIVENESS = 15
const MAX_VISUAL_FORM = 10
const MAX_INTERNET_RESONANCE = 10
const MAX_VERSATILITY = 5
const MAX_RESIDUE_PENALTY = 25
const MAX_CONFUSION_PENALTY = 15

const FALLBACK_FACET = FACETS[7]
const FALLBACK_FACET_BITS = 1 << 7

function isVowel(character: string): boolean {
  return 'aeiou'.includes(character)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

function suffixPenalty(label: string): number {
  for (const [suffix, penalty] of RESIDUE_SUFFIXES) {
    if (label.length > suffix.length + 1 && label.endsWith(suffix)) {
      return penalty
    }
  }
  return 0
}

/**
 * Repository-owned continuity score, mirrored from
 * `internal/ogranking.BaselineScores` and its integer final-score formula.
 *
 * It uses only local lexical features and is deliberately weaker than reviewed
 * editorial rank. Its safety comes from running over the allowlist only.
 */
export function deterministicFallbackScore(label: string): number {
  const length = label.length
  let vowels = 0
  let transitions = 0
  let common = 0
  let awkward = 0
  let rare = 0
  let repeats = 0
  const unique = new Set<string>()
  let maxVowelRun = 0
  let maxConsonantRun = 0
  let currentVowelRun = 0
  let currentConsonantRun = 0

  for (let index = 0; index < length; index++) {
    const character = label[index]
    if (character === undefined) {
      continue
    }
    unique.add(character)
    const vowel = isVowel(character)
    if (vowel) {
      vowels++
      currentVowelRun++
      currentConsonantRun = 0
      maxVowelRun = Math.max(maxVowelRun, currentVowelRun)
    } else {
      currentConsonantRun++
      currentVowelRun = 0
      maxConsonantRun = Math.max(maxConsonantRun, currentConsonantRun)
    }
    if ('jqvxzk'.includes(character)) {
      rare++
    }
    if (index > 0) {
      const previous = label[index - 1]
      if (previous === undefined) {
        continue
      }
      if (vowel !== isVowel(previous)) {
        transitions++
      }
      if (character === previous) {
        repeats++
      }
      const pair = `${previous}${character}`
      if (COMMON_BIGRAMS.has(pair)) {
        common++
      }
      if (AWKWARD_CLUSTERS.has(pair)) {
        awkward++
      }
    }
  }

  let pronounceable = 0
  if (vowels > 0) {
    pronounceable += 3
  }
  if (maxConsonantRun <= 2) {
    pronounceable += 3
  }
  if (maxVowelRun <= 2) {
    pronounceable += 2
  }
  if (transitions >= Math.floor(length / 2)) {
    pronounceable += 2
  }

  let residue = suffixPenalty(label)
  if (vowels === 0) {
    residue += 9
  }
  if (maxConsonantRun >= 4) {
    residue += 7
  }
  residue += awkward * 2
  residue += repeats

  let confusion = 0
  if (label.includes('q') && !label.includes('qu')) {
    confusion += 7
  }
  if (maxVowelRun >= 3) {
    confusion += 4
  }
  if (maxConsonantRun >= 4) {
    confusion += 5
  }
  confusion += repeats * 2
  if (label.endsWith('q') || label.endsWith('j') || label.endsWith('v')) {
    confusion += 4
  }
  if (vowels === 0 && label.includes('y')) {
    confusion -= 2
  }

  const short = 6 - length
  const recognizability = clamp(
    6 + common * 2 + pronounceable + transitions - awkward * 2,
    0,
    MAX_RECOGNIZABILITY,
  )
  const memorability = clamp(
    6 + short * 2 + pronounceable + transitions + rare - repeats * 2,
    0,
    MAX_MEMORABILITY,
  )
  const semanticDensity = clamp(
    4 + short * 2 + unique.size + rare - Math.trunc(residue / 4),
    0,
    MAX_SEMANTIC_DENSITY,
  )
  const distinctiveness = clamp(
    4 + unique.size + rare * 2 + short - repeats * 2,
    0,
    MAX_DISTINCTIVENESS,
  )
  const visualForm = clamp(
    3 + short + transitions + Math.trunc(unique.size / 2) - repeats - awkward,
    0,
    MAX_VISUAL_FORM,
  )
  let internetResonance = 2 + rare + short
  if (label.includes('ai') || label.includes('io')) {
    internetResonance += 2
  }
  if (/[xzv]/.test(label)) {
    internetResonance++
  }
  internetResonance = clamp(internetResonance, 0, MAX_INTERNET_RESONANCE)

  let versatility = 3
  if (residue >= 8) {
    versatility--
  }
  if (vowels === 0) {
    versatility--
  }
  versatility = clamp(versatility, 0, MAX_VERSATILITY)

  const positive =
    recognizability +
    memorability +
    semanticDensity +
    distinctiveness +
    visualForm +
    internetResonance +
    versatility
  const quality = clamp(
    positive - clamp(residue, 0, MAX_RESIDUE_PENALTY) - clamp(confusion, 0, MAX_CONFUSION_PENALTY),
    MIN_OG_SCORE,
    MAX_OG_SCORE / 10,
  )
  return quality * 10
}

/**
 * Scores only labels the reviewed policy admits and copies identity only from
 * snapshot results whose status is exactly `available`.
 */
export function fallbackCandidates(
  allowlist: FeatureAllowlist,
  results: readonly SnapshotResult[],
): readonly FeaturedName[] {
  const available = new Map<string, string>()
  for (const result of results) {
    if (result.status === 'available') {
      available.set(result.label, result.name)
    }
  }

  const candidates: FeaturedName[] = []
  for (const label of allowlist.labels) {
    const name = available.get(label)
    if (name === undefined) {
      continue
    }
    candidates.push({
      name,
      label,
      score: deterministicFallbackScore(label),
      facets: [FALLBACK_FACET],
      primaryFacet: FALLBACK_FACET,
    })
  }
  return candidates
}

/** The bit is kept named here to make the fallback facet contract explicit. */
export const DETERMINISTIC_FALLBACK_FACET_BITS = FALLBACK_FACET_BITS
