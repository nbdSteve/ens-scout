import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { compareNames } from '../format/text'
import { buildSnapshot } from '../test/factory'
import type { ResultSpec } from '../test/factory'
import type { Snapshot } from '../snapshot/types'
import { resolveFeaturedNames } from './resolve'

const RANK_TEXT = readFileSync(resolve(process.cwd(), 'public/data/og-rank-v1.json'), 'utf8')
const ALLOWLIST_TEXT = readFileSync(
  resolve(process.cwd(), 'src/data/featured-safe-v1.json'),
  'utf8',
)
const SELECTOR_FIXTURE = JSON.parse(
  readFileSync(resolve(process.cwd(), '../data/ranking/featured-safe-v1.fixture.json'), 'utf8'),
) as { readonly labels: readonly string[] }
const RANK_DOCUMENT = JSON.parse(RANK_TEXT) as {
  readonly items: readonly (readonly [string, number, number, number])[]
  readonly generator_manifest_sha256: string
}
const ALLOWLIST_DOCUMENT = JSON.parse(ALLOWLIST_TEXT) as {
  readonly labels: readonly string[]
}

function snapshotWith(results: readonly ResultSpec[]): Snapshot {
  const sorted = [...results].sort((left, right) => compareNames(left.name, right.name))
  return buildSnapshot({
    results: sorted,
    sources: [
      {
        id: 'ranked-fixture',
        path: 'data/words/ranked-fixture.txt',
        cadence: 'daily',
        names: sorted.length,
      },
    ],
  })
}

function allAvailable(labels: readonly string[]): Snapshot {
  return snapshotWith(labels.map((label) => ({ name: `${label}.eth`, status: 'available' })))
}

describe('resolveFeaturedNames', () => {
  const reviewedSnapshot = allAvailable(ALLOWLIST_DOCUMENT.labels)

  it('uses the reviewed artifact and returns one desktop order with a mobile prefix', () => {
    const selection = resolveFeaturedNames(
      reviewedSnapshot,
      JSON.parse(RANK_TEXT),
      JSON.parse(ALLOWLIST_TEXT),
    )
    expect(selection.source).toBe('reviewed-artifact')
    expect(selection.desktop).toHaveLength(12)
    expect(selection.mobile).toEqual(selection.desktop.slice(0, 7))
  })

  it('selects deterministically from the committed ranked allowlist fixture', () => {
    const selection = resolveFeaturedNames(
      allAvailable(SELECTOR_FIXTURE.labels),
      JSON.parse(RANK_TEXT),
      JSON.parse(ALLOWLIST_TEXT),
    )
    expect(selection.desktop.map((name) => name.label)).toEqual([
      'flux',
      'nova',
      'zine',
      'hex',
      'midi',
      'vex',
      'dub',
      'rune',
      'saga',
      'zap',
      'eon',
      'fuzz',
    ])
  })

  it('uses the deterministic safe fallback when the rank is missing or corrupt', () => {
    const missing = resolveFeaturedNames(reviewedSnapshot, null, JSON.parse(ALLOWLIST_TEXT))
    expect(missing.source).toBe('deterministic-fallback')
    expect(missing.desktop).toHaveLength(12)
    expect(missing.desktop.map((name) => name.label)).not.toEqual(
      [...missing.desktop.map((name) => name.label)].sort(compareNames),
    )

    const unsupported = resolveFeaturedNames(
      reviewedSnapshot,
      { format_version: 99 },
      JSON.parse(ALLOWLIST_TEXT),
    )
    expect(unsupported).toEqual(missing)
  })

  it('treats rank/allowlist disagreement as a fallback condition', () => {
    const rank = JSON.parse(RANK_TEXT) as Record<string, unknown>
    rank['generator_manifest_sha256'] = '0'.repeat(64)
    const selection = resolveFeaturedNames(reviewedSnapshot, rank, JSON.parse(ALLOWLIST_TEXT))
    expect(selection.source).toBe('deterministic-fallback')
  })

  it('omits featured selection when the safety policy is missing or incompatible', () => {
    const missing = resolveFeaturedNames(reviewedSnapshot, JSON.parse(RANK_TEXT), null)
    expect(missing).toEqual({ source: 'omitted', desktop: [], mobile: [] })

    const incompatible = JSON.parse(ALLOWLIST_TEXT) as Record<string, unknown>
    incompatible['policy_version'] = 'featured-safe-v2'
    expect(resolveFeaturedNames(reviewedSnapshot, JSON.parse(RANK_TEXT), incompatible)).toEqual(
      missing,
    )
  })

  it('produces byte-for-byte stable selections', () => {
    const first = JSON.stringify(
      resolveFeaturedNames(reviewedSnapshot, JSON.parse(RANK_TEXT), JSON.parse(ALLOWLIST_TEXT)),
    )
    const second = JSON.stringify(
      resolveFeaturedNames(reviewedSnapshot, JSON.parse(RANK_TEXT), JSON.parse(ALLOWLIST_TEXT)),
    )
    expect(second).toBe(first)
  })
})

describe('complete artifact runtime budget', () => {
  const fullSnapshot = allAvailable(RANK_DOCUMENT.items.map((tuple) => tuple[0]))
  const BUDGET_MS = 500

  it(`strictly parses and selects all 19,051 records within ${String(BUDGET_MS)} ms`, () => {
    const started = performance.now()
    const selection = resolveFeaturedNames(
      fullSnapshot,
      JSON.parse(RANK_TEXT),
      JSON.parse(ALLOWLIST_TEXT),
    )
    const elapsed = performance.now() - started

    expect(selection.source).toBe('reviewed-artifact')
    expect(selection.desktop).toHaveLength(12)
    expect(elapsed, `full ranking parse and selection took ${elapsed.toFixed(1)} ms`).toBeLessThan(
      BUDGET_MS,
    )
  })
})
