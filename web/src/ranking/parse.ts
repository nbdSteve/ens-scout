import { compareNames } from '../format/text'
import {
  ALLOWLIST_FORMAT_VERSION,
  CORPUS_COUNT,
  CORPUS_SHA256,
  FACETS,
  KNOWN_FACET_BITS,
  MAX_OG_SCORE,
  MIN_OG_SCORE,
  POLICY_VERSION,
  RANK_FORMAT_VERSION,
  RUBRIC_VERSION,
  type CorpusReference,
  type Facet,
  type FeatureAllowlist,
  type RankingArtifact,
  type RankingItem,
} from './contract'

export class RankingFormatError extends Error {
  override readonly name: string = 'RankingFormatError'
}

export class RankingVersionError extends RankingFormatError {
  override readonly name = 'RankingVersionError'

  readonly version: number

  constructor(version: number) {
    super(
      `this site reads rank format version ${String(RANK_FORMAT_VERSION)} but the artifact declares version ${String(version)}`,
    )
    this.version = version
  }
}

export class AllowlistFormatError extends Error {
  override readonly name: string = 'AllowlistFormatError'
}

export class AllowlistVersionError extends AllowlistFormatError {
  override readonly name = 'AllowlistVersionError'

  readonly version: number

  constructor(version: number) {
    super(
      `this site reads allowlist format version ${String(ALLOWLIST_FORMAT_VERSION)} but the policy declares version ${String(version)}`,
    )
    this.version = version
  }
}

type Fail = (message: string) => never

function asRecord(value: unknown, what: string, fail: Fail): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${what} must be an object`)
  }
  return value as Record<string, unknown>
}

function asArray(value: unknown, what: string, fail: Fail): unknown[] {
  if (!Array.isArray(value)) {
    fail(`${what} must be an array`)
  }
  return value
}

function asString(value: unknown, what: string, fail: Fail): string {
  if (typeof value !== 'string') {
    fail(`${what} must be a string`)
  }
  return value
}

function asInteger(value: unknown, what: string, fail: Fail): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail(`${what} must be an integer`)
  }
  return value
}

function exactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  what: string,
  fail: Fail,
): void {
  const actual = Object.keys(record).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${what} must contain exactly ${wanted.join(', ')}`)
  }
}

function asDigest(value: unknown, what: string, fail: Fail): string {
  const digest = asString(value, what, fail)
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    fail(`${what} must be a lowercase SHA-256 digest`)
  }
  return digest
}

/**
 * The compact artifacts cover the committed ASCII corpus, which is deliberately
 * stricter than the general ENS snapshot label contract.
 */
function asCorpusLabel(value: unknown, what: string, fail: Fail): string {
  const label = asString(value, what, fail)
  if (!/^[a-z]{3,5}$/.test(label)) {
    fail(`${what} must be a normalized bare 3..5 letter ASCII label`)
  }
  return label
}

function parseCorpus(value: unknown, what: string, fail: Fail): CorpusReference {
  const record = asRecord(value, what, fail)
  exactKeys(record, ['count', 'sha256'], what, fail)
  const count = asInteger(record['count'], `${what}.count`, fail)
  const sha256 = asDigest(record['sha256'], `${what}.sha256`, fail)
  if (count !== CORPUS_COUNT || sha256 !== CORPUS_SHA256) {
    fail(`${what} does not identify the reviewed v1 corpus`)
  }
  return { count, sha256 }
}

function facetsFromBits(bits: number, what: string, fail: Fail): readonly Facet[] {
  if (bits <= 0 || bits > KNOWN_FACET_BITS || (bits & ~KNOWN_FACET_BITS) !== 0) {
    fail(`${what} contains unknown facet bits`)
  }
  const facets: Facet[] = []
  for (const [index, facet] of FACETS.entries()) {
    if ((bits & (1 << index)) !== 0) {
      facets.push(facet)
    }
  }
  if (facets.length > 3) {
    fail(`${what} selects more than three facets`)
  }
  return facets
}

function parseRankingItem(value: unknown, index: number, fail: Fail): RankingItem {
  const what = `rank.items[${String(index)}]`
  const tuple = asArray(value, what, fail)
  if (tuple.length !== 4) {
    fail(`${what} must contain exactly four fields`)
  }
  const label = asCorpusLabel(tuple[0], `${what}[0]`, fail)
  const score = asInteger(tuple[1], `${what}[1]`, fail)
  if (score < MIN_OG_SCORE || score > MAX_OG_SCORE) {
    fail(`${what}[1] must be in ${String(MIN_OG_SCORE)}..${String(MAX_OG_SCORE)}`)
  }
  const facetBits = asInteger(tuple[2], `${what}[2]`, fail)
  const facets = facetsFromBits(facetBits, `${what}[2]`, fail)
  const flags = asInteger(tuple[3], `${what}[3]`, fail)
  if (flags !== 0) {
    fail(`${what}[3] contains unsupported flags`)
  }
  const primaryFacet = facets[0]
  if (primaryFacet === undefined) {
    fail(`${what}[2] contains no primary facet`)
  }
  return { label, score, facetBits, facets, primaryFacet }
}

/** Parses and validates the complete compact rank artifact. */
export function parseRankingArtifact(value: unknown): RankingArtifact {
  const fail = (message: string): never => {
    throw new RankingFormatError(message)
  }
  const root = asRecord(value, 'rank', fail)
  exactKeys(
    root,
    [
      'format_version',
      'corpus',
      'rubric_version',
      'policy_version',
      'generator_manifest_sha256',
      'items',
    ],
    'rank',
    fail,
  )

  const version = asInteger(root['format_version'], 'rank.format_version', fail)
  if (version !== RANK_FORMAT_VERSION) {
    throw new RankingVersionError(version)
  }
  const rubricVersion = asString(root['rubric_version'], 'rank.rubric_version', fail)
  if (rubricVersion !== RUBRIC_VERSION) {
    fail(`rank.rubric_version is unsupported: ${JSON.stringify(rubricVersion)}`)
  }
  const policyVersion = asString(root['policy_version'], 'rank.policy_version', fail)
  if (policyVersion !== POLICY_VERSION) {
    fail(`rank.policy_version is unsupported: ${JSON.stringify(policyVersion)}`)
  }

  const corpus = parseCorpus(root['corpus'], 'rank.corpus', fail)
  const rawItems = asArray(root['items'], 'rank.items', fail)
  if (rawItems.length !== corpus.count) {
    fail(
      `rank.items contains ${String(rawItems.length)} records but the corpus declares ${String(corpus.count)}`,
    )
  }

  const items: RankingItem[] = []
  const labels = new Set<string>()
  let previous: RankingItem | null = null
  for (const [index, raw] of rawItems.entries()) {
    const item = parseRankingItem(raw, index, fail)
    if (labels.has(item.label)) {
      fail(`rank.items duplicates ${JSON.stringify(item.label)}`)
    }
    labels.add(item.label)
    if (
      previous !== null &&
      (item.score > previous.score ||
        (item.score === previous.score && compareNames(item.label, previous.label) <= 0))
    ) {
      fail(`rank.items is not in canonical score and label order at ${JSON.stringify(item.label)}`)
    }
    previous = item
    items.push(item)
  }

  return {
    formatVersion: RANK_FORMAT_VERSION,
    corpus,
    rubricVersion: RUBRIC_VERSION,
    policyVersion: POLICY_VERSION,
    generatorManifestSha256: asDigest(
      root['generator_manifest_sha256'],
      'rank.generator_manifest_sha256',
      fail,
    ),
    items,
  }
}

/** Parses the repository-owned reviewed feature-safe allowlist. */
export function parseFeatureAllowlist(value: unknown): FeatureAllowlist {
  const fail = (message: string): never => {
    throw new AllowlistFormatError(message)
  }
  const root = asRecord(value, 'allowlist', fail)
  exactKeys(
    root,
    ['format_version', 'corpus', 'policy_version', 'generator_manifest_sha256', 'labels'],
    'allowlist',
    fail,
  )

  const version = asInteger(root['format_version'], 'allowlist.format_version', fail)
  if (version !== ALLOWLIST_FORMAT_VERSION) {
    throw new AllowlistVersionError(version)
  }
  const policyVersion = asString(root['policy_version'], 'allowlist.policy_version', fail)
  if (policyVersion !== POLICY_VERSION) {
    fail(`allowlist.policy_version is unsupported: ${JSON.stringify(policyVersion)}`)
  }

  const rawLabels = asArray(root['labels'], 'allowlist.labels', fail)
  if (rawLabels.length === 0) {
    fail('allowlist.labels must not be empty')
  }
  const labels: string[] = []
  let previous = ''
  for (const [index, raw] of rawLabels.entries()) {
    const label = asCorpusLabel(raw, `allowlist.labels[${String(index)}]`, fail)
    if (index > 0 && compareNames(label, previous) <= 0) {
      fail('allowlist.labels must be in canonical order without duplicates')
    }
    previous = label
    labels.push(label)
  }

  return {
    formatVersion: ALLOWLIST_FORMAT_VERSION,
    corpus: parseCorpus(root['corpus'], 'allowlist.corpus', fail),
    policyVersion: POLICY_VERSION,
    generatorManifestSha256: asDigest(
      root['generator_manifest_sha256'],
      'allowlist.generator_manifest_sha256',
      fail,
    ),
    labels,
  }
}

/**
 * Proves that the independently shipped rank and bundled safety policy describe
 * the same reviewed generation and that every safe label can be ranked.
 */
export function assertRankingCompatible(
  ranking: RankingArtifact,
  allowlist: FeatureAllowlist,
): void {
  if (
    ranking.corpus.count !== allowlist.corpus.count ||
    ranking.corpus.sha256 !== allowlist.corpus.sha256 ||
    ranking.generatorManifestSha256 !== allowlist.generatorManifestSha256
  ) {
    throw new RankingFormatError('rank and allowlist provenance disagree')
  }
  const ranked = new Set(ranking.items.map((item) => item.label))
  for (const label of allowlist.labels) {
    if (!ranked.has(label)) {
      throw new RankingFormatError(
        `rank has no record for allowlisted label ${JSON.stringify(label)}`,
      )
    }
  }
}
