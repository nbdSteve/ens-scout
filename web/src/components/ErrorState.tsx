import type { ReactNode } from 'react'
import type { LoadFailure } from '../state/useSnapshot'

/**
 * The load failed and there is nothing to fall back on.
 *
 * The three failure kinds get three different explanations, because they need
 * three different things from the visitor. A version mismatch means this page is
 * older than the data and a reload fixes it. A malformed payload means the data
 * is wrong and a reload will not fix it. An unreachable API means neither is
 * broken, and retrying is worth doing.
 *
 * The underlying message is shown rather than hidden. It names a route or a field,
 * which is what makes the failure reportable, and it can never contain a
 * credential: the browser holds none.
 */
export interface ErrorStateProps {
  readonly failure: LoadFailure
  readonly onRetry: () => void
}

const EXPLANATION: Readonly<Record<LoadFailure['kind'], string>> = {
  malformed:
    'The snapshot did not match the published format, so it was refused rather than shown in part. A snapshot is only useful if every status in it can be trusted.',
  version:
    'The snapshot was published in a newer format than this page understands. Reloading should pick up the current version of the page.',
  unavailable:
    'The published snapshot could not be read. This browser has no stored copy to fall back on, so there is nothing to show yet.',
}

const RETRY_LABEL: Readonly<Record<LoadFailure['kind'], string>> = {
  malformed: 'Try loading it again',
  version: 'Reload the page',
  unavailable: 'Try again',
}

export function ErrorState({ failure, onRetry }: ErrorStateProps): ReactNode {
  return (
    <div className="card state" role="alert">
      <h2 className="state__title">The snapshot could not be shown</h2>
      <p className="prose">{EXPLANATION[failure.kind]}</p>
      <p className="prose">
        Reported reason: <span className="mono">{failure.message}</span>
      </p>
      <button className="button" onClick={onRetry} type="button">
        {RETRY_LABEL[failure.kind]}
      </button>
      <p className="prose">
        Availability and price are decided by ENS, never by this page. You can check any name
        directly at <a href="https://app.ens.domains/">app.ens.domains</a>.
      </p>
    </div>
  )
}
