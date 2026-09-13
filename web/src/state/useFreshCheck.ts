import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppConfig } from '../config/env'
import { STATUS_LABEL } from '../snapshot/lifecycle'
import type { CheckOptions } from '../verify/check'
import { requestCheck } from '../verify/check'
import { CHECK_MAX_NAMES } from '../verify/contract'
import { describeCheckFailure, type CheckFailure } from '../verify/failure'
import { resolveOutbound } from '../verify/gate'
import type { Verification, VerifiedNames } from '../verify/types'

/**
 * Selecting names and verifying them.
 *
 * Three rules shape all of it, and each of them is a thing the page must never do.
 *
 * It never erases the visitor's selection. A check that is throttled, timed out, or
 * refused leaves every box ticked, because the visitor's work was choosing the names
 * and a failure of ours is not a reason to make them choose again.
 *
 * It never substitutes a snapshot answer for a fresh one. A failed check adds nothing
 * to `verified`, so `resolveOutbound` goes on refusing those names and the page goes
 * on showing the scan's status labelled as the scan's status. There is no fallback
 * path here at all - not a stale entry reused, not a status copied across.
 *
 * It never drops a verification it already has. Each name carries the instant it was
 * checked and its own expiry, so checking a third name does not take the first two's
 * links away, and an expired entry is kept rather than deleted - the page can then say
 * the check has lapsed, which it could not do from an absence.
 */

export interface FreshCheckStore {
  /** Whether this deployment has a verifier at all. False in fixture mode. */
  readonly available: boolean
  readonly selected: ReadonlySet<string>
  /** True once the selection holds as many names as one check covers. */
  readonly full: boolean
  /** The names the check in flight covers. Empty when nothing is in flight. */
  readonly pending: ReadonlySet<string>
  readonly checking: boolean
  readonly verified: VerifiedNames
  /** The last check's failure, in the page's own words. Cleared when another starts. */
  readonly failure: CheckFailure | null
  readonly announcement: string
  readonly toggle: (name: string) => void
  readonly clearSelection: () => void
  readonly check: () => void
  readonly dismissFailure: () => void
}

/** Injected for tests. Defaults to the real client. */
export interface FreshCheckDeps {
  readonly requestCheck?: (options: CheckOptions) => Promise<Verification>
}

const NO_NAMES: ReadonlySet<string> = new Set<string>()
const NO_VERIFICATIONS: VerifiedNames = new Map()

interface VerificationState {
  readonly verified: VerifiedNames
  readonly completion: Verification | null
}

const NO_VERIFICATION_STATE: VerificationState = {
  verified: NO_VERIFICATIONS,
  completion: null,
}

function completionAnnouncement(view: Verification, verified: VerifiedNames, now: Date): string {
  if (view.results.length === 0) {
    return 'Fresh check completed. No status was returned, so no ENS link is actionable.'
  }
  const statuses = view.results
    .map((result) => `${result.name} returned ${STATUS_LABEL[result.status]}`)
    .join('; ')
  const verdicts = view.results.map((result) => resolveOutbound(result.name, verified, now))
  const actionable = verdicts.filter((verdict) => verdict.allowed).length
  const expired = verdicts.filter(
    (verdict) => !verdict.allowed && verdict.reason === 'expired',
  ).length
  let links: string
  if (view.results.length === 1) {
    links =
      actionable === 1
        ? 'Its ENS link is now actionable.'
        : expired === 1
          ? 'The fresh check has expired, so its ENS link is not actionable.'
          : 'Its ENS link is not actionable.'
  } else if (actionable === view.results.length) {
    links = 'Their ENS links are now actionable.'
  } else if (expired === view.results.length) {
    links = 'The fresh check has expired, so their ENS links are not actionable.'
  } else if (actionable === 0) {
    links = 'Their ENS links are not actionable.'
  } else {
    links = `${String(actionable)} of ${String(view.results.length)} ENS links are currently actionable.`
  }
  return `Fresh check completed. ${statuses}. ${links}`
}

export function useFreshCheck(
  config: AppConfig,
  now: Date,
  deps: FreshCheckDeps = {},
): FreshCheckStore {
  const [selected, setSelected] = useState<ReadonlySet<string>>(NO_NAMES)
  const [pending, setPending] = useState<ReadonlySet<string>>(NO_NAMES)
  const [verificationState, setVerificationState] =
    useState<VerificationState>(NO_VERIFICATION_STATE)
  const [failure, setFailure] = useState<CheckFailure | null>(null)
  const { verified, completion } = verificationState

  const { apiBaseUrl } = config
  const verify = deps.requestCheck ?? requestCheck
  const inFlight = useRef<AbortController | null>(null)

  // A check in flight when the page goes away is abandoned rather than left to settle
  // into state nothing renders.
  useEffect(
    () => () => {
      inFlight.current?.abort()
    },
    [],
  )

  const toggle = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.delete(name)) {
        return next
      }
      // The bound is held here as well as in the client, so a name beyond it is never
      // added rather than added and then refused. The toolbar states the bound before
      // this matters, and disables the boxes it would refuse.
      if (next.size >= CHECK_MAX_NAMES) {
        return prev
      }
      next.add(name)
      return next
    })
  }, [])

  const clearSelection = useCallback(() => {
    setSelected(NO_NAMES)
  }, [])

  const dismissFailure = useCallback(() => {
    setFailure(null)
  }, [])

  const check = useCallback(() => {
    if (apiBaseUrl === null || selected.size === 0) {
      return
    }
    // A second check replaces the first rather than racing it. Both would answer about
    // real names, but the later request is the one the visitor asked for.
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller

    const names = [...selected]
    setPending(new Set(names))
    setFailure(null)
    setVerificationState((prev) =>
      prev.completion === null ? prev : { ...prev, completion: null },
    )

    void (async (): Promise<void> => {
      try {
        const view = await verify({
          baseUrl: apiBaseUrl,
          names,
          signal: controller.signal,
        })
        if (controller.signal.aborted) {
          return
        }
        setVerificationState((prev) => {
          const next = new Map(prev.verified)
          for (const result of view.results) {
            next.set(result.name, {
              result,
              checkedAt: view.checkedAt,
              expiresAt: view.expiresAt,
            })
          }
          return { verified: next, completion: view }
        })
      } catch (cause) {
        if (controller.signal.aborted) {
          // A cancelled check is not a failed one. A visitor who changed their selection
          // must not be shown an error about the request they replaced.
          return
        }
        // Nothing is added to `verified` and nothing already in it is touched. The
        // selection is left exactly as it was.
        setFailure(describeCheckFailure(cause))
      } finally {
        if (inFlight.current === controller) {
          inFlight.current = null
          setPending(NO_NAMES)
        }
      }
    })()
  }, [apiBaseUrl, selected, verify])

  const announcement = completion === null ? '' : completionAnnouncement(completion, verified, now)

  return {
    available: apiBaseUrl !== null,
    selected,
    full: selected.size >= CHECK_MAX_NAMES,
    pending,
    checking: pending.size > 0,
    verified,
    failure,
    announcement,
    toggle,
    clearSelection,
    check,
    dismissFailure,
  }
}
