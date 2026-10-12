import type { Snapshot } from '../snapshot/types'
import type { FeaturedSelection } from './contract'
import { fallbackCandidates } from './fallback'
import {
  AllowlistFormatError,
  RankingFormatError,
  parseFeatureAllowlist,
  parseRankingArtifact,
} from './parse'
import { mobileFeaturedNames, reviewedCandidates, selectEditorialCandidates } from './select'

function omittedSelection(): FeaturedSelection {
  return {
    source: 'omitted',
    desktop: [],
    mobile: [],
  }
}

/**
 * Resolves the runtime source without changing any other snapshot behavior.
 *
 * A refused rank falls back to local deterministic scoring over the already
 * validated safety policy. A refused safety policy omits featured names
 * entirely. Neither condition throws into snapshot discovery.
 */
export function resolveFeaturedNames(
  snapshot: Snapshot,
  rankDocument: unknown,
  allowlistDocument: unknown,
): FeaturedSelection {
  let allowlist
  try {
    allowlist = parseFeatureAllowlist(allowlistDocument)
  } catch (cause) {
    if (cause instanceof AllowlistFormatError) {
      return omittedSelection()
    }
    throw cause
  }

  let source: FeaturedSelection['source'] = 'reviewed-artifact'
  let candidates
  try {
    const ranking = parseRankingArtifact(rankDocument)
    candidates = reviewedCandidates(ranking, allowlist, snapshot.results)
  } catch (cause) {
    if (!(cause instanceof RankingFormatError)) {
      throw cause
    }
    source = 'deterministic-fallback'
    candidates = fallbackCandidates(allowlist, snapshot.results)
  }

  const desktop = selectEditorialCandidates(candidates)
  return {
    source,
    desktop,
    mobile: mobileFeaturedNames(desktop),
  }
}
