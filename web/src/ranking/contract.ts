/**
 * The browser's closed contract for the reviewed OG ranking artifacts.
 *
 * Ranking is editorial data only. Nothing in either artifact can state or
 * influence availability, registration, expiry, premium, price, or legal
 * status. The selector joins these records to a separately parsed snapshot and
 * keeps only results whose published status is exactly `available`.
 */

export const RANK_FORMAT_VERSION = 1
export const ALLOWLIST_FORMAT_VERSION = 1
export const RUBRIC_VERSION = 'og-v1'
export const POLICY_VERSION = 'featured-safe-v1'

/** Canonical fixed corpus recorded by the reviewed v1 artifacts. */
export const CORPUS_COUNT = 19_051
export const CORPUS_SHA256 = '647b9aa913803510f5ab875136771c5cc3e663445524cc77e0dfd7a7cd6251e8'

export const MIN_OG_SCORE = 0
export const MAX_OG_SCORE = 1000

/**
 * Bit order is part of the compact artifact contract. The first set bit is the
 * primary facet used by the diversity pass.
 */
export const FACETS = [
  'culture_language',
  'internet',
  'technology',
  'arts_music',
  'nature',
  'science',
  'playful',
  'abstract_conceptual',
] as const

export type Facet = (typeof FACETS)[number]

export const KNOWN_FACET_BITS = (1 << FACETS.length) - 1

export interface CorpusReference {
  readonly count: number
  readonly sha256: string
}

/** One validated compact tuple, expanded into named runtime fields. */
export interface RankingItem {
  readonly label: string
  readonly score: number
  readonly facetBits: number
  readonly facets: readonly Facet[]
  readonly primaryFacet: Facet
}

export interface RankingArtifact {
  readonly formatVersion: typeof RANK_FORMAT_VERSION
  readonly corpus: CorpusReference
  readonly rubricVersion: typeof RUBRIC_VERSION
  readonly policyVersion: typeof POLICY_VERSION
  readonly generatorManifestSha256: string
  readonly items: readonly RankingItem[]
}

/**
 * The only reviewed eligibility input the browser accepts.
 *
 * Absence from this list means ineligible. The rank artifact cannot override it.
 */
export interface FeatureAllowlist {
  readonly formatVersion: typeof ALLOWLIST_FORMAT_VERSION
  readonly corpus: CorpusReference
  readonly policyVersion: typeof POLICY_VERSION
  readonly generatorManifestSha256: string
  readonly labels: readonly string[]
}

/** A ranked, snapshot-backed name that is safe to hand to later presentation. */
export interface FeaturedName {
  /** Fully qualified name copied from the parsed snapshot. */
  readonly name: string
  /** Exact normalized bare label used for the artifact/snapshot join. */
  readonly label: string
  readonly score: number
  readonly facets: readonly Facet[]
  readonly primaryFacet: Facet
}

export type FeaturedSource = 'reviewed-artifact' | 'deterministic-fallback' | 'omitted'

/**
 * The complete pure runtime result. Mobile is always a prefix of desktop and is
 * never ranked independently.
 */
export interface FeaturedSelection {
  readonly source: FeaturedSource
  readonly desktop: readonly FeaturedName[]
  readonly mobile: readonly FeaturedName[]
}
