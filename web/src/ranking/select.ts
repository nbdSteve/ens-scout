import { codePointLength, codePoints, compareNames } from '../format/text'
import type { SnapshotResult } from '../snapshot/types'
import type {
  Facet,
  FeatureAllowlist,
  FeaturedName,
  RankingArtifact,
  RankingItem,
} from './contract'
import { assertRankingCompatible } from './parse'

export const DESKTOP_FEATURED_COUNT = 12
export const MOBILE_FEATURED_COUNT = 7

const UNCONSTRAINED_HEAD_COUNT = 4
const MAX_PRIMARY_FACET_COUNT = 3
const MAX_LENGTH_COUNT = 4

/**
 * Longest first, matching the repository baseline's residue families. A suffix
 * is removed only when at least three characters remain, so a short standalone
 * label is not reduced to noise.
 */
const STEM_SUFFIXES = [
  'ings',
  'ers',
  'ies',
  'ied',
  'est',
  'ing',
  'ed',
  'es',
  'er',
  'ly',
  's',
] as const

/** A morphology-only family key; it never changes artifact/snapshot identity. */
export function normalizedStem(label: string): string {
  const characters = codePoints(label.toLowerCase())
  for (const suffix of STEM_SUFFIXES) {
    const ending = codePoints(suffix)
    if (characters.length > ending.length + 2 && label.toLowerCase().endsWith(suffix)) {
      return characters.slice(0, -ending.length).join('')
    }
  }
  return characters.join('')
}

/** Whether two strings are exactly one insertion, deletion, or substitution apart. */
function oneEditApart(left: string, right: string): boolean {
  const a = codePoints(left)
  const b = codePoints(right)
  if (Math.abs(a.length - b.length) > 1) {
    return false
  }
  if (a.length === b.length) {
    let differences = 0
    for (const [index, value] of a.entries()) {
      if (value !== b[index]) {
        differences++
        if (differences > 1) {
          return false
        }
      }
    }
    return differences === 1
  }

  const shorter = a.length < b.length ? a : b
  const longer = a.length < b.length ? b : a
  let shortIndex = 0
  let longIndex = 0
  let skipped = false
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex++
      longIndex++
      continue
    }
    if (skipped) {
      return false
    }
    skipped = true
    longIndex++
  }
  return true
}

/**
 * Three-letter words remain distinct after one changed character; for stems of
 * four or more characters, one edit is close enough to defer the later name.
 */
export function areNearDuplicates(left: string, right: string): boolean {
  const a = normalizedStem(left)
  const b = normalizedStem(right)
  if (a === b) {
    return true
  }
  return Math.max(codePointLength(a), codePointLength(b)) >= 4 && oneEditApart(a, b)
}

function compareCandidates(left: FeaturedName, right: FeaturedName): number {
  return left.score === right.score
    ? compareNames(left.label, right.label)
    : right.score - left.score
}

function addCount<K>(counts: Map<K, number>, key: K): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

function recordSelection(
  candidate: FeaturedName,
  selected: FeaturedName[],
  facetCounts: Map<Facet, number>,
  lengthCounts: Map<number, number>,
): void {
  selected.push(candidate)
  addCount(facetCounts, candidate.primaryFacet)
  addCount(lengthCounts, codePointLength(candidate.label))
}

function hasSelectedRelative(candidate: FeaturedName, selected: readonly FeaturedName[]): boolean {
  return selected.some((existing) => areNearDuplicates(candidate.label, existing.label))
}

/**
 * Applies the approved deterministic head, diversity, and deferred-fill rules.
 *
 * Input order is never trusted. The score and canonical-label sort is repeated
 * here so direct callers and the fallback receive the same total order.
 */
export function selectEditorialCandidates(
  candidates: readonly FeaturedName[],
  limit = DESKTOP_FEATURED_COUNT,
): readonly FeaturedName[] {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError('featured selection limit must be a non-negative integer')
  }
  const ranked = [...candidates].sort(compareCandidates)
  const selected: FeaturedName[] = []
  const deferred: FeaturedName[] = []
  const facetCounts = new Map<Facet, number>()
  const lengthCounts = new Map<number, number>()

  const headCount = Math.min(UNCONSTRAINED_HEAD_COUNT, limit, ranked.length)
  for (const candidate of ranked.slice(0, headCount)) {
    recordSelection(candidate, selected, facetCounts, lengthCounts)
  }

  for (const candidate of ranked.slice(headCount)) {
    if (selected.length === limit) {
      break
    }
    const length = codePointLength(candidate.label)
    const facetFull = (facetCounts.get(candidate.primaryFacet) ?? 0) >= MAX_PRIMARY_FACET_COUNT
    const lengthFull = (lengthCounts.get(length) ?? 0) >= MAX_LENGTH_COUNT
    if (facetFull || lengthFull || hasSelectedRelative(candidate, selected)) {
      deferred.push(candidate)
      continue
    }
    recordSelection(candidate, selected, facetCounts, lengthCounts)
  }

  if (selected.length < limit) {
    selected.push(...deferred.slice(0, limit - selected.length))
  }
  return selected
}

function availableByLabel(results: readonly SnapshotResult[]): ReadonlyMap<string, string> {
  const available = new Map<string, string>()
  for (const result of results) {
    if (result.status === 'available') {
      available.set(result.label, result.name)
    }
  }
  return available
}

function toFeatured(item: RankingItem, name: string): FeaturedName {
  return {
    name,
    label: item.label,
    score: item.score,
    facets: item.facets,
    primaryFacet: item.primaryFacet,
  }
}

/**
 * Exact safe-label and snapshot join for the reviewed rank.
 *
 * The rank contributes only score and facets. The fully qualified name and the
 * decision to admit it come from the parsed snapshot and reviewed allowlist.
 */
export function reviewedCandidates(
  ranking: RankingArtifact,
  allowlist: FeatureAllowlist,
  results: readonly SnapshotResult[],
): readonly FeaturedName[] {
  assertRankingCompatible(ranking, allowlist)
  const safe = new Set(allowlist.labels)
  const available = availableByLabel(results)
  const candidates: FeaturedName[] = []
  for (const item of ranking.items) {
    if (!safe.has(item.label)) {
      continue
    }
    const name = available.get(item.label)
    if (name !== undefined) {
      candidates.push(toFeatured(item, name))
    }
  }
  return candidates
}

/** Selects the reviewed desktop set from one immutable snapshot input. */
export function selectReviewedNames(
  ranking: RankingArtifact,
  allowlist: FeatureAllowlist,
  results: readonly SnapshotResult[],
): readonly FeaturedName[] {
  return selectEditorialCandidates(reviewedCandidates(ranking, allowlist, results))
}

/** The only supported mobile derivation: a prefix of the desktop result. */
export function mobileFeaturedNames(desktop: readonly FeaturedName[]): readonly FeaturedName[] {
  return desktop.slice(0, MOBILE_FEATURED_COUNT)
}
