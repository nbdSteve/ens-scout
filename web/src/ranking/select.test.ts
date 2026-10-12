import { describe, expect, it } from 'vitest'
import {
  FACETS,
  type Facet,
  type FeatureAllowlist,
  type FeaturedName,
  type RankingArtifact,
  type RankingItem,
} from './contract'
import { buildResults } from '../test/factory'
import type { Status } from '../snapshot/contract'
import type { SnapshotResult } from '../snapshot/types'
import {
  areNearDuplicates,
  mobileFeaturedNames,
  normalizedStem,
  selectEditorialCandidates,
  selectReviewedNames,
} from './select'

const MANIFEST = 'a'.repeat(64)
const CORPUS = { count: 19_051, sha256: 'b'.repeat(64) }

function item(label: string, score: number, primaryFacet: Facet): RankingItem {
  const facetIndex = FACETS.findIndex((facet) => facet === primaryFacet)
  if (facetIndex < 0) {
    throw new Error('test supplied an unknown facet')
  }
  return {
    label,
    score,
    facetBits: 1 << facetIndex,
    facets: [primaryFacet],
    primaryFacet,
  }
}

function candidate(label: string, score: number, primaryFacet: Facet): FeaturedName {
  const ranked = item(label, score, primaryFacet)
  return { ...ranked, name: `${label}.eth` }
}

function ranking(items: readonly RankingItem[]): RankingArtifact {
  return {
    formatVersion: 1,
    corpus: CORPUS,
    rubricVersion: 'og-v1',
    policyVersion: 'featured-safe-v1',
    generatorManifestSha256: MANIFEST,
    items,
  }
}

function allowlist(labels: readonly string[]): FeatureAllowlist {
  return {
    formatVersion: 1,
    corpus: CORPUS,
    policyVersion: 'featured-safe-v1',
    generatorManifestSha256: MANIFEST,
    labels,
  }
}

function result(label: string, status: Status): SnapshotResult {
  return {
    name: `${label}.eth`,
    label,
    status,
    expiry: null,
    graceEnds: null,
    premiumEnds: null,
  }
}

const labelsOf = (values: readonly FeaturedName[]): readonly string[] =>
  values.map((value) => value.label)

describe('selectEditorialCandidates', () => {
  it('takes the strongest four without applying diversity constraints', () => {
    const candidates = [
      candidate('aaad', 970, 'internet'),
      candidate('aaab', 990, 'internet'),
      candidate('aaac', 980, 'internet'),
      candidate('aaaa', 1000, 'internet'),
      candidate('midi', 960, 'internet'),
    ]

    expect(labelsOf(selectEditorialCandidates(candidates).slice(0, 4))).toEqual([
      'aaaa',
      'aaab',
      'aaac',
      'aaad',
    ])
  })

  it('enforces facet, length, and near-duplicate limits before filling from deferred rank order', () => {
    const candidates = [
      candidate('nova', 1000, 'internet'),
      candidate('midi', 990, 'internet'),
      candidate('zine', 980, 'culture_language'),
      candidate('axiom', 970, 'technology'),
      candidate('axion', 960, 'science'),
      candidate('rune', 950, 'culture_language'),
      candidate('saga', 940, 'arts_music'),
      candidate('vex', 930, 'culture_language'),
      candidate('dub', 920, 'culture_language'),
      candidate('zap', 910, 'internet'),
      candidate('mix', 900, 'technology'),
      candidate('pixel', 890, 'abstract_conceptual'),
      candidate('orbit', 880, 'science'),
      candidate('viral', 870, 'abstract_conceptual'),
      candidate('synth', 860, 'technology'),
    ]

    expect(labelsOf(selectEditorialCandidates(candidates))).toEqual([
      'nova',
      'midi',
      'zine',
      'axiom',
      'rune',
      'vex',
      'zap',
      'mix',
      'pixel',
      'orbit',
      'viral',
      'axion',
    ])
  })

  it('uses canonical label order as the final score tie-break', () => {
    const candidates = [
      candidate('zed', 900, 'internet'),
      candidate('midi', 900, 'technology'),
      candidate('axe', 900, 'culture_language'),
    ]
    expect(labelsOf(selectEditorialCandidates(candidates))).toEqual(['axe', 'midi', 'zed'])
  })

  it('returns byte-for-byte stable output for the same input', () => {
    const candidates = [
      candidate('zine', 990, 'culture_language'),
      candidate('flux', 990, 'internet'),
      candidate('nova', 990, 'nature'),
      candidate('midi', 980, 'technology'),
      candidate('rune', 970, 'abstract_conceptual'),
    ]
    const first = JSON.stringify(selectEditorialCandidates(candidates))
    const second = JSON.stringify(selectEditorialCandidates(candidates))
    expect(second).toBe(first)
  })

  it('derives mobile as exactly the first seven desktop names', () => {
    const desktop = selectEditorialCandidates(
      Array.from({ length: 12 }, (_, index) =>
        candidate(
          `name${String(index).padStart(2, '0')}`,
          1000 - index,
          FACETS[index % FACETS.length] ?? FACETS[0],
        ),
      ),
    )
    expect(mobileFeaturedNames(desktop)).toEqual(desktop.slice(0, 7))
    expect(mobileFeaturedNames(desktop)).toHaveLength(7)
  })

  it('keeps 32- and 64-character synthetic labels safe as pure selection inputs', () => {
    const labels = ['a'.repeat(32), 'b'.repeat(64), 'short', 'other']
    const selected = selectEditorialCandidates(
      labels.map((label, index) => candidate(label, 1000 - index, FACETS[index] ?? FACETS[0])),
    )
    expect(labelsOf(selected)).toEqual(labels)
    expect(() => JSON.stringify(selected)).not.toThrow()
  })
})

describe('normalized name families', () => {
  it('groups inflections and one-edit longer stems without conflating three-letter words', () => {
    expect(normalizedStem('signals')).toBe('signal')
    expect(areNearDuplicates('signal', 'signals')).toBe(true)
    expect(areNearDuplicates('axiom', 'axion')).toBe(true)
    expect(areNearDuplicates('hex', 'vex')).toBe(false)
  })
})

describe('selectReviewedNames', () => {
  it('adds a newly available name at its editorial rank and removes it immediately later', () => {
    const ranked = ranking([
      item('nova', 1000, 'nature'),
      item('zine', 900, 'culture_language'),
      item('midi', 800, 'technology'),
    ])
    const safe = allowlist(['midi', 'nova', 'zine'])

    const before = selectReviewedNames(ranked, safe, [
      result('nova', 'registered'),
      result('zine', 'available'),
      result('midi', 'available'),
    ])
    expect(labelsOf(before)).toEqual(['zine', 'midi'])

    const next = selectReviewedNames(ranked, safe, [
      result('nova', 'available'),
      result('zine', 'available'),
      result('midi', 'available'),
    ])
    expect(labelsOf(next)).toEqual(['nova', 'zine', 'midi'])

    const later = selectReviewedNames(ranked, safe, [
      result('nova', 'available'),
      result('zine', 'premium'),
      result('midi', 'available'),
    ])
    expect(labelsOf(later)).toEqual(['nova', 'midi'])
  })

  it('admits no non-available lifecycle status', () => {
    const statuses: readonly Status[] = [
      'registered',
      'expiring-soon',
      'grace-period',
      'grace-ending-soon',
      'premium',
      'unknown',
    ]
    const labels = ['reg', 'soon', 'grace', 'ending', 'prem', 'unk']
    const ranked = ranking([
      item('open', 1000, 'internet'),
      ...labels.map((label, index) => item(label, 900 - index, FACETS[index] ?? FACETS[0])),
    ])
    const safe = allowlist(['ending', 'grace', 'open', 'prem', 'reg', 'soon', 'unk'])
    const results = [
      result('open', 'available'),
      ...labels.map((label, index) => result(label, statuses[index] ?? 'unknown')),
    ]

    expect(labelsOf(selectReviewedNames(ranked, safe, results))).toEqual(['open'])
  })

  it('excludes every unsafe or unreviewed category even when the snapshot says available', () => {
    const unsafe = ['sex', 'kkk', 'apple', 'trump', 'admin', 'bomb', 'fox']
    const ranked = ranking([
      ...unsafe.map((label, index) => item(label, 1000 - index, FACETS[index] ?? FACETS[0])),
      item('vex', 800, 'abstract_conceptual'),
    ])
    const safe = allowlist(['vex'])
    const results = buildResults([...unsafe, 'vex'])

    expect(labelsOf(selectReviewedNames(ranked, safe, results))).toEqual(['vex'])
  })
})
