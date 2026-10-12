import { act, renderHook, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compareNames } from '../format/text'
import type { Snapshot } from '../snapshot/types'
import { buildSnapshot } from '../test/factory'
import { useFeaturedNames, type FeaturedNamesDeps } from './useFeaturedNames'

const RANK_DOCUMENT = JSON.parse(
  readFileSync(resolve(process.cwd(), 'public/data/og-rank-v1.json'), 'utf8'),
) as unknown
const ALLOWLIST_DOCUMENT = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/data/featured-safe-v1.json'), 'utf8'),
) as { readonly labels: readonly string[] }

function rankedSnapshot(): Snapshot {
  const results = ALLOWLIST_DOCUMENT.labels
    .map((label) => ({ name: `${label}.eth`, status: 'available' as const }))
    .sort((left, right) => compareNames(left.name, right.name))
  return buildSnapshot({
    results,
    sources: [
      {
        id: 'ranked',
        path: 'data/words/ranked.txt',
        cadence: 'daily',
        names: results.length,
      },
    ],
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('useFeaturedNames', () => {
  it('starts the rank load before the snapshot settles and resolves the reviewed selection', async () => {
    const loadRank = vi.fn(() => Promise.resolve(RANK_DOCUMENT))
    const deps: FeaturedNamesDeps = { loadRank, allowlistDocument: ALLOWLIST_DOCUMENT }
    const { result, rerender } = renderHook(
      ({ snapshot }: { readonly snapshot: Snapshot | null }) =>
        useFeaturedNames(snapshot, true, deps),
      { initialProps: { snapshot: null as Snapshot | null } },
    )

    expect(loadRank).toHaveBeenCalledTimes(1)
    expect(result.current.phase).toBe('loading')

    rerender({ snapshot: rankedSnapshot() })
    await waitFor(() => {
      expect(result.current.phase).toBe('ready')
    })
    expect(result.current.selection?.source).toBe('reviewed-artifact')
    expect(result.current.selection?.desktop).toHaveLength(12)
    expect(result.current.selection?.mobile).toEqual(result.current.selection?.desktop.slice(0, 7))
  })

  it('uses the deterministic fallback when loading is refused', async () => {
    const deps: FeaturedNamesDeps = {
      allowlistDocument: ALLOWLIST_DOCUMENT,
      loadRank: () => Promise.reject(new Error('missing')),
    }
    const { result } = renderHook(() => useFeaturedNames(rankedSnapshot(), true, deps))

    await waitFor(() => {
      expect(result.current.selection?.source).toBe('deterministic-fallback')
    })
  })

  it('bounds a slow rank and falls back without delaying snapshot discovery', async () => {
    vi.useFakeTimers()
    const deps: FeaturedNamesDeps = {
      allowlistDocument: ALLOWLIST_DOCUMENT,
      loadRank: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
      timeoutMs: 25,
    }
    const { result } = renderHook(() => useFeaturedNames(rankedSnapshot(), true, deps))

    expect(result.current.phase).toBe('loading')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25)
    })
    expect(result.current.selection?.source).toBe('deterministic-fallback')
  })

  it('omits immediately and makes no rank request when the safety policy is unusable', () => {
    const loadRank = vi.fn(() => Promise.resolve(RANK_DOCUMENT))
    const { result } = renderHook(() =>
      useFeaturedNames(rankedSnapshot(), true, {
        allowlistDocument: null,
        loadRank,
      }),
    )

    expect(result.current).toEqual({
      phase: 'ready',
      selection: { source: 'omitted', desktop: [], mobile: [] },
    })
    expect(loadRank).not.toHaveBeenCalled()
  })

  it('does nothing off the canonical route', () => {
    const loadRank = vi.fn(() => Promise.resolve(RANK_DOCUMENT))
    const { result } = renderHook(() =>
      useFeaturedNames(rankedSnapshot(), false, {
        allowlistDocument: ALLOWLIST_DOCUMENT,
        loadRank,
      }),
    )

    expect(result.current).toEqual({ phase: 'disabled', selection: null })
    expect(loadRank).not.toHaveBeenCalled()
  })
})
