import type { ReactNode } from 'react'
import { CHECK_MAX_NAMES } from '../verify/contract'
import { checkNeedsNewBundle, type CheckFailure } from '../verify/failure'
import { Notice } from './Notice'
import { reloadDocument } from './recovery'

/**
 * The fresh-check action.
 *
 * It lives inside the results panel, directly above the table, and it renders only once
 * the visitor has ticked something or a check has failed. That is a first-screen budget
 * decision rather than a layout one: `the first screen is the answer, not an
 * introduction` charges anything above the list against a name row, and a bar explaining
 * a feature nobody has used yet would cost a row on every visit.
 *
 * The failure banner is here rather than in the advisories block at the top of the page.
 * A failed check is about an action the visitor just took, so it belongs beside the
 * button they pressed; the advisories block is for what is wrong with the snapshot or the
 * link they arrived on. It declares `role="alert"`, which governs its own subtree, so it
 * is announced from here without needing the block's polite region.
 *
 * The banner states that the selection is unchanged, because that is the promise the page
 * is making and a visitor cannot see the whole list from here to confirm it. It never
 * offers a snapshot status as a substitute answer: a fresh check that failed produced no
 * evidence, and the scan's status is already on screen labelled as the scan's status.
 */
export interface VerifyBarProps {
  readonly selected: ReadonlySet<string>
  readonly checking: boolean
  readonly failure: CheckFailure | null
  readonly onCheck: () => void
  readonly onClear: () => void
  readonly onDismiss: () => void
}

export function VerifyBar({
  selected,
  checking,
  failure,
  onCheck,
  onClear,
  onDismiss,
}: VerifyBarProps): ReactNode {
  const count = selected.size
  if (count === 0 && failure === null) {
    return null
  }
  const needsReload = failure !== null && checkNeedsNewBundle(failure.kind)

  return (
    <div className="verify-bar">
      <div className="verify-bar__row">
        {/*
          The count is a status region so a change is announced without moving focus.
          The bound is stated here rather than only enforced, because the tick boxes go
          disabled at it and a control that stops working without saying why is worse
          than one that never worked.
        */}
        <p className="verify-bar__count" role="status">
          {count === 0
            ? 'Nothing selected'
            : `${String(count)} of ${String(CHECK_MAX_NAMES)} names selected`}
        </p>
        <div className="verify-bar__actions">
          <button
            className="button"
            disabled={checking || count === 0}
            onClick={onCheck}
            type="button"
          >
            {checking ? 'Checking' : 'Check these now'}
          </button>
          {count > 0 && (
            <button className="button button--quiet" onClick={onClear} type="button">
              Clear selection
            </button>
          )}
        </div>
      </div>

      <p className="verify-bar__note">
        A fresh check re-reads the ENS index for the selected names and opens their links for a
        short while. It is not a reservation, and ENS is the final authority on whether a name can
        be registered.
      </p>

      {failure !== null && (
        <Notice tone="warn" voice="alert" title="Fresh check failed">
          <p>{failure.message}</p>
          <p>
            Your selection is unchanged, and no status on this page was replaced by a guess. The
            statuses below are still what the scan recorded.
          </p>
          <p className="verify-bar__recover">
            {failure.retryable && !needsReload && (
              <button className="button button--quiet" onClick={onCheck} type="button">
                Try again
              </button>
            )}
            {needsReload && (
              <button className="button button--quiet" onClick={reloadDocument} type="button">
                Reload the page
              </button>
            )}
            <button className="button button--quiet" onClick={onDismiss} type="button">
              Dismiss
            </button>
          </p>
        </Notice>
      )}
    </div>
  )
}
