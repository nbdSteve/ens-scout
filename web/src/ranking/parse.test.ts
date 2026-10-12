import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CORPUS_COUNT,
  CORPUS_SHA256,
  POLICY_VERSION,
  RANK_FORMAT_VERSION,
  RUBRIC_VERSION,
} from './contract'
import {
  AllowlistFormatError,
  AllowlistVersionError,
  RankingFormatError,
  RankingVersionError,
  assertRankingCompatible,
  parseFeatureAllowlist,
  parseRankingArtifact,
} from './parse'

interface MutableRankDocument extends Record<string, unknown> {
  format_version: unknown
  corpus: Record<string, unknown>
  rubric_version: unknown
  policy_version: unknown
  generator_manifest_sha256: unknown
  items: unknown[][]
}

interface MutableAllowlistDocument extends Record<string, unknown> {
  format_version: unknown
  corpus: Record<string, unknown>
  policy_version: unknown
  generator_manifest_sha256: unknown
  labels: unknown[]
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8')) as unknown
}

const COMMITTED_RANK = readJson('public/data/og-rank-v1.json')
const COMMITTED_ALLOWLIST = readJson('src/data/featured-safe-v1.json')

function rankDocument(): MutableRankDocument {
  return structuredClone(COMMITTED_RANK) as MutableRankDocument
}

function allowlistDocument(): MutableAllowlistDocument {
  return structuredClone(COMMITTED_ALLOWLIST) as MutableAllowlistDocument
}

describe('parseRankingArtifact', () => {
  it('accepts the complete committed contract', () => {
    const parsed = parseRankingArtifact(COMMITTED_RANK)
    expect(parsed.formatVersion).toBe(RANK_FORMAT_VERSION)
    expect(parsed.corpus).toEqual({ count: CORPUS_COUNT, sha256: CORPUS_SHA256 })
    expect(parsed.rubricVersion).toBe(RUBRIC_VERSION)
    expect(parsed.policyVersion).toBe(POLICY_VERSION)
    expect(parsed.items).toHaveLength(CORPUS_COUNT)
    expect(parsed.items[0]).toMatchObject({ label: 'flux', score: 990 })
  })

  it('refuses an unsupported version with its own error type', () => {
    const document = rankDocument()
    document.format_version = 2
    const parse = (): unknown => parseRankingArtifact(document)
    expect(parse).toThrow(RankingVersionError)
    expect(parse).toThrow(/version 2/)
  })

  it.each(['rubric_version', 'items'])('refuses a missing root key: %s', (key) => {
    const document = rankDocument()
    const missing = Object.fromEntries(Object.entries(document).filter(([field]) => field !== key))
    expect(() => parseRankingArtifact(missing)).toThrow(RankingFormatError)
  })

  it('refuses extra root and corpus keys', () => {
    const root = rankDocument()
    root['availability'] = 'available'
    expect(() => parseRankingArtifact(root)).toThrow(RankingFormatError)

    const nested = rankDocument()
    nested.corpus['source'] = 'somewhere'
    expect(() => parseRankingArtifact(nested)).toThrow(RankingFormatError)
  })

  it.each([null, [], 'rank', 42])('refuses a malformed root shape: %j', (value) => {
    expect(() => parseRankingArtifact(value)).toThrow(RankingFormatError)
  })

  it('refuses a malformed or over-wide tuple', () => {
    const object = rankDocument()
    object.items[0] = [{ label: 'flux' }]
    expect(() => parseRankingArtifact(object)).toThrow(RankingFormatError)

    const extra = rankDocument()
    extra.items[0] = ['flux', 990, 134, 0, 'available']
    expect(() => parseRankingArtifact(extra)).toThrow(RankingFormatError)
  })

  it('refuses unsupported rubric and policy versions', () => {
    const rubric = rankDocument()
    rubric.rubric_version = 'og-v2'
    expect(() => parseRankingArtifact(rubric)).toThrow(RankingFormatError)

    const policy = rankDocument()
    policy.policy_version = 'featured-safe-v2'
    expect(() => parseRankingArtifact(policy)).toThrow(RankingFormatError)
  })

  it.each([
    ['uppercase', 'Flux'],
    ['qualified', 'flux.eth'],
    ['too short', 'go'],
    ['too long', 'signal'],
    ['punctuation', 'fl-ux'],
  ])('refuses a %s label', (_what, label) => {
    const document = rankDocument()
    document.items[0] = [label, 990, 134, 0]
    expect(() => parseRankingArtifact(document)).toThrow(RankingFormatError)
  })

  it('refuses a duplicate label', () => {
    const document = rankDocument()
    const first = document.items[0]
    const second = document.items[1]
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    document.items[1] = [first?.[0], second?.[1], second?.[2], second?.[3]]
    expect(() => parseRankingArtifact(document)).toThrow(/duplicates/)
  })

  it.each([-1, 1001, 1.5])('refuses an invalid score: %s', (score) => {
    const document = rankDocument()
    const first = document.items[0]
    document.items[0] = [first?.[0], score, first?.[2], first?.[3]]
    expect(() => parseRankingArtifact(document)).toThrow(RankingFormatError)
  })

  it.each([0, 256, 15, 1.5])('refuses unknown or over-wide facet bits: %s', (bits) => {
    const document = rankDocument()
    const first = document.items[0]
    document.items[0] = [first?.[0], first?.[1], bits, first?.[3]]
    expect(() => parseRankingArtifact(document)).toThrow(RankingFormatError)
  })

  it.each([-1, 1, 0.5])('refuses unsupported flags: %s', (flags) => {
    const document = rankDocument()
    const first = document.items[0]
    document.items[0] = [first?.[0], first?.[1], first?.[2], flags]
    expect(() => parseRankingArtifact(document)).toThrow(RankingFormatError)
  })

  it('refuses a corpus count or hash mismatch', () => {
    const count = rankDocument()
    count.corpus['count'] = CORPUS_COUNT - 1
    expect(() => parseRankingArtifact(count)).toThrow(/reviewed v1 corpus/)

    const hash = rankDocument()
    hash.corpus['sha256'] = '0'.repeat(64)
    expect(() => parseRankingArtifact(hash)).toThrow(/reviewed v1 corpus/)
  })

  it('refuses a rank record count that disagrees with the corpus', () => {
    const document = rankDocument()
    document.items.pop()
    expect(() => parseRankingArtifact(document)).toThrow(/19050 records/)
  })

  it('refuses non-canonical rank order instead of repairing it', () => {
    const document = rankDocument()
    const first = document.items[0]
    const second = document.items[1]
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    document.items[0] = second ?? []
    document.items[1] = first ?? []
    expect(() => parseRankingArtifact(document)).toThrow(/canonical/)
  })
})

describe('parseFeatureAllowlist', () => {
  it('accepts the committed reviewed policy', () => {
    const parsed = parseFeatureAllowlist(COMMITTED_ALLOWLIST)
    expect(parsed.labels).toHaveLength(73)
    expect(parsed.labels[0]).toBe('alive')
    expect(parsed.labels.at(-1)).toBe('zone')
  })

  it('refuses an unsupported version with its own error type', () => {
    const document = allowlistDocument()
    document.format_version = 2
    expect(() => parseFeatureAllowlist(document)).toThrow(AllowlistVersionError)
  })

  it('refuses missing, extra, or unsupported policy fields', () => {
    const missing = allowlistDocument()
    const withoutLabels = Object.fromEntries(
      Object.entries(missing).filter(([field]) => field !== 'labels'),
    )
    expect(() => parseFeatureAllowlist(withoutLabels)).toThrow(AllowlistFormatError)

    const extra = allowlistDocument()
    extra['eligibility'] = 'featureable'
    expect(() => parseFeatureAllowlist(extra)).toThrow(AllowlistFormatError)

    const policy = allowlistDocument()
    policy.policy_version = 'featured-safe-v2'
    expect(() => parseFeatureAllowlist(policy)).toThrow(AllowlistFormatError)
  })

  it('refuses a policy with mismatched corpus identity', () => {
    const count = allowlistDocument()
    count.corpus['count'] = CORPUS_COUNT + 1
    expect(() => parseFeatureAllowlist(count)).toThrow(AllowlistFormatError)

    const hash = allowlistDocument()
    hash.corpus['sha256'] = '0'.repeat(64)
    expect(() => parseFeatureAllowlist(hash)).toThrow(AllowlistFormatError)
  })

  it.each(['Alive', 'alive.eth', 'go', 'signal'])('refuses non-canonical label %s', (label) => {
    const document = allowlistDocument()
    document.labels[0] = label
    expect(() => parseFeatureAllowlist(document)).toThrow(AllowlistFormatError)
  })

  it('refuses an empty, duplicated, or reordered allowlist', () => {
    const empty = allowlistDocument()
    empty.labels = []
    expect(() => parseFeatureAllowlist(empty)).toThrow(AllowlistFormatError)

    const duplicate = allowlistDocument()
    duplicate.labels[1] = duplicate.labels[0]
    expect(() => parseFeatureAllowlist(duplicate)).toThrow(AllowlistFormatError)

    const reordered = allowlistDocument()
    const first = reordered.labels[0]
    const second = reordered.labels[1]
    reordered.labels[0] = second
    reordered.labels[1] = first
    expect(() => parseFeatureAllowlist(reordered)).toThrow(AllowlistFormatError)
  })
})

describe('assertRankingCompatible', () => {
  it('accepts the matching committed pair', () => {
    expect(() => {
      assertRankingCompatible(
        parseRankingArtifact(COMMITTED_RANK),
        parseFeatureAllowlist(COMMITTED_ALLOWLIST),
      )
    }).not.toThrow()
  })

  it('refuses a rank from a different reviewed generation', () => {
    const ranking = parseRankingArtifact(COMMITTED_RANK)
    const allowlist = parseFeatureAllowlist(COMMITTED_ALLOWLIST)
    expect(() => {
      assertRankingCompatible({ ...ranking, generatorManifestSha256: '0'.repeat(64) }, allowlist)
    }).toThrow(/provenance disagree/)
  })

  it('refuses an allowlisted label with no rank record', () => {
    const ranking = parseRankingArtifact(COMMITTED_RANK)
    const allowlist = parseFeatureAllowlist(COMMITTED_ALLOWLIST)
    const missing = allowlist.labels[0]
    expect(missing).toBeDefined()
    expect(() => {
      assertRankingCompatible(
        { ...ranking, items: ranking.items.filter((item) => item.label !== missing) },
        allowlist,
      )
    }).toThrow(/no record/)
  })
})
