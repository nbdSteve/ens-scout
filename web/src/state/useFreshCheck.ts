import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppConfig } from '../config/env'
import type { CheckOptions } from '../verify/check'
import { requestCheck } from '../verify/check'
import { CHECK_MAX_NAMES } from '../verify/contract'
import { describeCheckFailure, type CheckFailure } from '../verify/failure'
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

export function useFreshCheck(config: AppConfig, deps: FreshCheckDeps = {}): FreshCheckStore {
  const [selected, setSelected] = useState<ReadonlySet<string>>(NO_NAMES)
  const [pending, setPending] = useState<ReadonlySet<string>>(NO_NAMES)
  const [verified, setVerified] = useState<VerifiedNames>(NO_VERIFICATIONS)
  const [failure, setFailure] = useState<CheckFailure | null>(null)

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
        setVerified((prev) => {
          const next = new Map(prev)
          for (const result of view.results) {
            next.set(result.name, {
              result,
              checkedAt: view.checkedAt,
              expiresAt: view.expiresAt,
            })
          }
          return next
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

  return {
    available: apiBaseUrl !== null,
    selected,
    full: selected.size >= CHECK_MAX_NAMES,
    pending,
    checking: pending.size > 0,
    verified,
    failure,
    toggle,
    clearSelection,
    check,
    dismissFailure,
  }
}
