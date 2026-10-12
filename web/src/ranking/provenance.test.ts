import featureAllowlistDocument from '../data/featured-safe-v1.json'
import provenanceDocument from '../data/featured-ranking-provenance-v1.json'
import { describe, expect, it } from 'vitest'
import { parseFeatureAllowlist } from './parse'
import {
  FEATURED_RANKING_PROVENANCE,
  RANKING_ARTIFACT_VERSION,
  RANKING_METHOD,
  RankingProvenanceError,
  featuredSourceLabel,
  parseRankingProvenance,
  shortDigest,
} from './provenance'

function document(): Record<string, unknown> {
  return structuredClone(provenanceDocument)
}

describe('parseRankingProvenance', () => {
  it('accepts the generated public manifest subset and ties it to the safety policy', () => {
    const parsed = parseRankingProvenance(provenanceDocument)
    const allowlist = parseFeatureAllowlist(featureAllowlistDocument)

    expect(parsed.method).toBe(RANKING_METHOD)
    expect(parsed.artifactVersion).toBe(RANKING_ARTIFACT_VERSION)
    expect(parsed.generatorManifestSha256).toBe(allowlist.generatorManifestSha256)
    expect(parsed.model).toMatchObject({
      provider: 'amazon-bedrock',
      modelId: 'openai.gpt-5.6-sol',
      modelRevision: 'openai.gpt-5.6-sol',
      runsPerLabel: 3,
    })
    expect(parsed.review).toMatchObject({ reviewedAt: '2026-10-11', headCount: 128 })
    expect(FEATURED_RANKING_PROVENANCE).toEqual(parsed)
  })

  it('refuses extra, secret-shaped, and unbounded manifest fields', () => {
    const extra = document()
    extra['request_id'] = 'provider-request'
    expect(() => parseRankingProvenance(extra)).toThrow(RankingProvenanceError)

    const model = document()
    model['model'] = {
      ...(model['model'] as Record<string, unknown>),
      credentials: 'not-public',
    }
    expect(() => parseRankingProvenance(model)).toThrow(RankingProvenanceError)
  })

  it('refuses a different corpus, manifest shape, or review scope', () => {
    const corpus = document()
    corpus['corpus'] = {
      ...(corpus['corpus'] as Record<string, unknown>),
      sha256: '0'.repeat(64),
    }
    expect(() => parseRankingProvenance(corpus)).toThrow(RankingProvenanceError)

    const review = document()
    review['review'] = {
      ...(review['review'] as Record<string, unknown>),
      scope: ['ranked head'],
    }
    expect(() => parseRankingProvenance(review)).toThrow(RankingProvenanceError)
  })
})

describe('featured provenance presentation helpers', () => {
  it('distinguishes every runtime source without weakening the safety boundary', () => {
    expect(featuredSourceLabel('reviewed-artifact')).toBe('Reviewed artifact')
    expect(featuredSourceLabel('deterministic-fallback')).toContain(
      'reviewed safety allowlist only',
    )
    expect(featuredSourceLabel('omitted')).toContain('reviewed safety policy unavailable')
  })

  it('keeps hashes compact without changing their identity prefix', () => {
    expect(shortDigest('a'.repeat(64))).toBe(`${'a'.repeat(12)}…`)
  })
})
