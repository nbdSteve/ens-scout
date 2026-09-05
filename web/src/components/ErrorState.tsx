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
  /**
   * How a document reload is performed. Injected for tests, since the real one would
   * take the test runner's page with it.
   */
  readonly onReload?: () => void
}

function reloadDocument(): void {
  window.location.reload()
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

export function ErrorState({
  failure,
  onRetry,
  onReload = reloadDocument,
}: ErrorStateProps): ReactNode {
  /*
   * A version mismatch is the one failure retrying cannot fix. The payload is newer than
   * this bundle, so fetching it again from the same bundle lands on the same error, and
   * only a document load can pick up a newer one. The button says it reloads the page, so
   * it reloads the page: a button that claimed an action it had not taken would be the
   * same failure of trust as a status this page had not really read.
   */
  const press = failure.kind === 'version' ? onReload : onRetry

  return (
    <div className="card state" role="alert">
      <h2 className="state__title">The snapshot could not be shown</h2>
      <p className="prose">{EXPLANATION[failure.kind]}</p>
      <p className="prose">
        Reported reason: <span className="mono">{failure.message}</span>
      </p>
      <button className="button" onClick={press} type="button">
        {RETRY_LABEL[failure.kind]}
      </button>
      <p className="prose">
        Availability and price are decided by ENS, never by this page. You can check any name
        directly at <a href="https://app.ens.domains/">app.ens.domains</a>.
      </p>
    </div>
  )
}
