import { useEffect, useMemo, useState } from 'react'
import featureAllowlistDocument from '../data/featured-safe-v1.json'
import type { FeaturedSelection } from '../ranking/contract'
import { AllowlistFormatError, parseFeatureAllowlist } from '../ranking/parse'
import { resolveFeaturedNames } from '../ranking/resolve'
import type { Snapshot } from '../snapshot/types'

export const RANK_ARTIFACT_PATH = 'data/og-rank-v1.json'
export const RANK_LOAD_TIMEOUT_MS = 3000

export interface FeaturedNamesDeps {
  readonly allowlistDocument?: unknown
  readonly loadRank?: (signal: AbortSignal) => Promise<unknown>
  readonly timeoutMs?: number
}

export type FeaturedNamesStore =
  | { readonly phase: 'disabled'; readonly selection: null }
  | { readonly phase: 'loading'; readonly selection: null }
  | { readonly phase: 'ready'; readonly selection: FeaturedSelection }

interface RankState {
  readonly phase: 'loading' | 'settled'
  readonly document: unknown
}

const LOADING_RANK: RankState = { phase: 'loading', document: null }

const OMITTED: FeaturedSelection = {
  source: 'omitted',
  desktop: [],
  mobile: [],
}

async function loadRankArtifact(signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`${import.meta.env.BASE_URL}${RANK_ARTIFACT_PATH}`, {
    cache: 'force-cache',
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) {
    throw new Error('the featured rank artifact could not be loaded')
  }
  return response.json() as Promise<unknown>
}

function hasValidSafetyPolicy(document: unknown): boolean {
  try {
    parseFeatureAllowlist(document)
    return true
  } catch (cause) {
    if (cause instanceof AllowlistFormatError) {
      return false
    }
    return false
  }
}

/**
 * Loads the immutable rank independently of the snapshot request.
 *
 * A failed or slow rank settles as `null`, which the existing resolver treats as
 * deterministic fallback over the validated allowlist. An unusable allowlist
 * never starts the fetch and omits the hero immediately.
 */
export function useFeaturedNames(
  snapshot: Snapshot | null,
  enabled: boolean,
  deps: FeaturedNamesDeps = {},
): FeaturedNamesStore {
  const allowlistDocument =
    deps.allowlistDocument === undefined ? featureAllowlistDocument : deps.allowlistDocument
  const loadRank = deps.loadRank ?? loadRankArtifact
  const timeoutMs = deps.timeoutMs ?? RANK_LOAD_TIMEOUT_MS
  const policyValid = useMemo(() => hasValidSafetyPolicy(allowlistDocument), [allowlistDocument])
  const [rank, setRank] = useState<RankState>(LOADING_RANK)

  useEffect(() => {
    if (!enabled || !policyValid) {
      return
    }

    const controller = new AbortController()
    let live = true
    const timer = window.setTimeout(() => {
      controller.abort()
    }, timeoutMs)

    void loadRank(controller.signal)
      .then((document) => {
        if (live) {
          setRank({ phase: 'settled', document })
        }
      })
      .catch(() => {
        if (live) {
          setRank({ phase: 'settled', document: null })
        }
      })
      .finally(() => {
        window.clearTimeout(timer)
      })

    return () => {
      live = false
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [enabled, loadRank, policyValid, timeoutMs])

  return useMemo(() => {
    if (!enabled) {
      return { phase: 'disabled', selection: null }
    }
    if (!policyValid) {
      return { phase: 'ready', selection: OMITTED }
    }
    if (snapshot === null || rank.phase === 'loading') {
      return { phase: 'loading', selection: null }
    }
    try {
      return {
        phase: 'ready',
        selection: resolveFeaturedNames(snapshot, rank.document, allowlistDocument),
      }
    } catch {
      return { phase: 'ready', selection: OMITTED }
    }
  }, [allowlistDocument, enabled, policyValid, rank, snapshot])
}
