import type { ReactNode } from 'react'
import type { LoadFailure } from '../state/useSnapshot'
import { Notice } from './Notice'
import { needsNewBundle, reloadDocument } from './recovery'

/**
 * An earlier scan is on screen because this visit could not replace it.
 *
 * Three different things bring a visitor here, and the band says which one: the API was
 * not reachable, it answered with a payload this build refused, or it answered in a format
 * this build does not know. One sentence for all three claimed the API was unreachable,
 * which is false for the two where it answered - and this page's whole contract is that it
 * never states something it has not established.
 */
const WHAT_HAPPENED: Readonly<Record<LoadFailure['kind'], string>> = {
  unavailable: 'The read API could not be reached',
  malformed: 'The read API answered with a snapshot this page could not read',
  version: 'The read API answered in a format newer than this page understands',
}

const ACTION_LABEL: Readonly<Record<LoadFailure['kind'], string>> = {
  unavailable: 'Try to refresh',
  malformed: 'Try to refresh',
  version: 'Reload the page',
}

export interface StoredCopyNoticeProps {
  readonly failure: LoadFailure
  readonly onRetry: () => void
  /**
   * How a document reload is performed. Injected for tests, since the real one would take
   * the test runner's page with it.
   */
  readonly onReload?: () => void
}

export function StoredCopyNotice({
  failure,
  onRetry,
  onReload = reloadDocument,
}: StoredCopyNoticeProps): ReactNode {
  const press = needsNewBundle(failure.kind) ? onReload : onRetry

  return (
    <Notice tone="warn" title="Showing a stored copy" voice="alert">
      <p>
        {WHAT_HAPPENED[failure.kind]}, so this is the snapshot this browser stored on an earlier
        visit. It has not been refreshed. Reported reason:{' '}
        <span className="mono">{failure.message}</span>
      </p>
      <p>
        <button className="button" onClick={press} type="button">
          {ACTION_LABEL[failure.kind]}
        </button>
      </p>
    </Notice>
  )
}
