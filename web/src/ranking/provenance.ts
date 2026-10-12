import featureAllowlistDocument from '../data/featured-safe-v1.json'
import provenanceDocument from '../data/featured-ranking-provenance-v1.json'
import {
  CORPUS_COUNT,
  CORPUS_SHA256,
  POLICY_VERSION,
  RUBRIC_VERSION,
  type CorpusReference,
  type FeaturedSource,
} from './contract'
import { parseFeatureAllowlist } from './parse'

export const RANKING_PROVENANCE_FORMAT_VERSION = 1
export const RANKING_METHOD = 'Global OG score + diversity'
export const RANKING_ARTIFACT_VERSION = 'og-rank-v1'

const REVIEW_SCOPE = [
  'ranked head',
  'all deterministic policy findings',
  'all model policy signals',
  'all feature-safe labels',
] as const

export interface RankingModelProvenance {
  readonly provider: string
  readonly modelId: string
  readonly modelRevision: string
  readonly generatedAt: string
  readonly runsPerLabel: number
}

export interface RankingReviewProvenance {
  readonly reviewedAt: string
  readonly headCount: number
  readonly scope: readonly string[]
}

export interface RankingProvenance {
  readonly formatVersion: typeof RANKING_PROVENANCE_FORMAT_VERSION
  readonly method: typeof RANKING_METHOD
  readonly artifactVersion: typeof RANKING_ARTIFACT_VERSION
  readonly corpus: CorpusReference
  readonly rubricVersion: typeof RUBRIC_VERSION
  readonly policyVersion: typeof POLICY_VERSION
  readonly generatorManifestSha256: string
  readonly promptSha256: string
  readonly model: RankingModelProvenance
  readonly review: RankingReviewProvenance
}

export class RankingProvenanceError extends Error {
  override readonly name = 'RankingProvenanceError'
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
  value: Record<string, unknown>,
  expected: readonly string[],
  what: string,
  fail: Fail,
): void {
  const actual = Object.keys(value).sort()
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

function asBoundedText(value: unknown, what: string, fail: Fail): string {
  const text = asString(value, what, fail)
  const hasControlCharacter = Array.from(text).some((character) => {
    const codePoint = character.codePointAt(0)
    return (
      codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    )
  })
  if (text.length === 0 || text.length > 120 || hasControlCharacter) {
    fail(`${what} must be short printable text`)
  }
  return text
}

function asInstant(value: unknown, what: string, fail: Fail): string {
  const text = asString(value, what, fail)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(text)) {
    fail(`${what} must be a UTC timestamp with second precision`)
  }
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== text.replace(/Z$/, '.000Z')) {
    fail(`${what} must be a real instant`)
  }
  return text
}

function asDate(value: unknown, what: string, fail: Fail): string {
  const text = asString(value, what, fail)
  const parsed = new Date(`${text}T00:00:00Z`)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== text
  ) {
    fail(`${what} must be a real UTC date`)
  }
  return text
}

function parseCorpus(value: unknown, fail: Fail): CorpusReference {
  const corpus = asRecord(value, 'provenance.corpus', fail)
  exactKeys(corpus, ['count', 'sha256'], 'provenance.corpus', fail)
  const count = asInteger(corpus['count'], 'provenance.corpus.count', fail)
  const sha256 = asDigest(corpus['sha256'], 'provenance.corpus.sha256', fail)
  if (count !== CORPUS_COUNT || sha256 !== CORPUS_SHA256) {
    fail('provenance.corpus does not identify the reviewed v1 corpus')
  }
  return { count, sha256 }
}

function parseModel(value: unknown, fail: Fail): RankingModelProvenance {
  const model = asRecord(value, 'provenance.model', fail)
  exactKeys(
    model,
    ['provider', 'model_id', 'model_revision', 'generated_at', 'runs_per_label'],
    'provenance.model',
    fail,
  )
  const runsPerLabel = asInteger(model['runs_per_label'], 'provenance.model.runs_per_label', fail)
  if (runsPerLabel < 1 || runsPerLabel > 10) {
    fail('provenance.model.runs_per_label must be in 1..10')
  }
  return {
    provider: asBoundedText(model['provider'], 'provenance.model.provider', fail),
    modelId: asBoundedText(model['model_id'], 'provenance.model.model_id', fail),
    modelRevision: asBoundedText(model['model_revision'], 'provenance.model.model_revision', fail),
    generatedAt: asInstant(model['generated_at'], 'provenance.model.generated_at', fail),
    runsPerLabel,
  }
}

function parseReview(value: unknown, fail: Fail): RankingReviewProvenance {
  const review = asRecord(value, 'provenance.review', fail)
  exactKeys(review, ['reviewed_at', 'head_count', 'scope'], 'provenance.review', fail)
  const headCount = asInteger(review['head_count'], 'provenance.review.head_count', fail)
  if (headCount < 1 || headCount > CORPUS_COUNT) {
    fail(`provenance.review.head_count must be in 1..${String(CORPUS_COUNT)}`)
  }
  const scope = asArray(review['scope'], 'provenance.review.scope', fail).map((entry, index) =>
    asBoundedText(entry, `provenance.review.scope[${String(index)}]`, fail),
  )
  if (
    scope.length !== REVIEW_SCOPE.length ||
    scope.some((entry, index) => entry !== REVIEW_SCOPE[index])
  ) {
    fail('provenance.review.scope does not match the reviewed v1 scope')
  }
  return {
    reviewedAt: asDate(review['reviewed_at'], 'provenance.review.reviewed_at', fail),
    headCount,
    scope,
  }
}

export function parseRankingProvenance(value: unknown): RankingProvenance {
  const fail = (message: string): never => {
    throw new RankingProvenanceError(message)
  }
  const root = asRecord(value, 'provenance', fail)
  exactKeys(
    root,
    [
      'format_version',
      'method',
      'artifact_version',
      'corpus',
      'rubric_version',
      'policy_version',
      'generator_manifest_sha256',
      'prompt_sha256',
      'model',
      'review',
    ],
    'provenance',
    fail,
  )

  const formatVersion = asInteger(root['format_version'], 'provenance.format_version', fail)
  if (formatVersion !== RANKING_PROVENANCE_FORMAT_VERSION) {
    fail(`provenance.format_version ${String(formatVersion)} is unsupported`)
  }
  const method = asString(root['method'], 'provenance.method', fail)
  if (method !== RANKING_METHOD) {
    fail('provenance.method is unsupported')
  }
  const artifactVersion = asString(root['artifact_version'], 'provenance.artifact_version', fail)
  if (artifactVersion !== RANKING_ARTIFACT_VERSION) {
    fail('provenance.artifact_version is unsupported')
  }
  const rubricVersion = asString(root['rubric_version'], 'provenance.rubric_version', fail)
  if (rubricVersion !== RUBRIC_VERSION) {
    fail('provenance.rubric_version is unsupported')
  }
  const policyVersion = asString(root['policy_version'], 'provenance.policy_version', fail)
  if (policyVersion !== POLICY_VERSION) {
    fail('provenance.policy_version is unsupported')
  }

  return {
    formatVersion: RANKING_PROVENANCE_FORMAT_VERSION,
    method: RANKING_METHOD,
    artifactVersion: RANKING_ARTIFACT_VERSION,
    corpus: parseCorpus(root['corpus'], fail),
    rubricVersion: RUBRIC_VERSION,
    policyVersion: POLICY_VERSION,
    generatorManifestSha256: asDigest(
      root['generator_manifest_sha256'],
      'provenance.generator_manifest_sha256',
      fail,
    ),
    promptSha256: asDigest(root['prompt_sha256'], 'provenance.prompt_sha256', fail),
    model: parseModel(root['model'], fail),
    review: parseReview(root['review'], fail),
  }
}

function loadBundledProvenance(): RankingProvenance | null {
  try {
    const provenance = parseRankingProvenance(provenanceDocument)
    const allowlist = parseFeatureAllowlist(featureAllowlistDocument)
    if (provenance.generatorManifestSha256 !== allowlist.generatorManifestSha256) {
      throw new RankingProvenanceError('provenance and safety policy identify different manifests')
    }
    return provenance
  } catch {
    return null
  }
}

export const FEATURED_RANKING_PROVENANCE = loadBundledProvenance()

export function featuredSourceLabel(source: FeaturedSource): string {
  switch (source) {
    case 'reviewed-artifact':
      return 'Reviewed artifact'
    case 'deterministic-fallback':
      return 'Deterministic fallback · reviewed safety allowlist only'
    case 'omitted':
      return 'Omitted · reviewed safety policy unavailable'
  }
}

export function shortDigest(digest: string): string {
  return `${digest.slice(0, 12)}…`
}
