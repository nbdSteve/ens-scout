import type { ReactNode } from 'react'
import { STATUSES, type Status } from '../snapshot/contract'
import { STATUS_DESCRIPTION, STATUS_LABEL, STATUS_TONE } from '../snapshot/lifecycle'
import type { SnapshotMetadata } from '../snapshot/types'

/**
 * What the scan found, by status.
 *
 * These are the publisher's own counts, straight from the snapshot metadata, not
 * a tally of the rows currently on screen: the summary answers "what did this scan
 * find" and must not change when a visitor types in the search box. Statuses are
 * listed in the published order, so the same scan always reads the same way.
 *
 * It is a description list and not a set of links. Making the numbers clickable
 * would be an invitation to read them as filters, and they are not - the counts
 * cover the whole snapshot while the filters act within a view.
 */
export interface SummaryCountsProps {
  readonly metadata: SnapshotMetadata
}

export function SummaryCounts({ metadata }: SummaryCountsProps): ReactNode {
  // A status no name is in is left out rather than shown as a zero. Seven zeroes
  // say less than the one sentence below does.
  const shown: readonly Status[] = STATUSES.filter((status) => metadata.counts[status] > 0)

  return (
    <section className="card summary" aria-labelledby="summary-heading">
      <div>
        {/* An `h3`, for the same reason as the scan card: this sits inside the
            disclosure below the results, not at the top level of the page. */}
        <h3 className="card__title" id="summary-heading">
          What this scan found
        </h3>
        <p className="summary__total">
          {metadata.names.toLocaleString('en-GB')} {metadata.names === 1 ? 'name' : 'names'} checked
        </p>
      </div>
      {shown.length === 0 ? (
        <p className="prose">This scan checked no names, so there is nothing to summarize.</p>
      ) : (
        <dl className="counts">
          {shown.map((status) => (
            <div className={`count count--${STATUS_TONE[status]}`} key={status}>
              <dt className="count__label">
                {STATUS_LABEL[status]}{' '}
                {/*
                  The tone is a colour; the meaning has to be readable too. The
                  separator sits outside the span, because text assembled from
                  several elements is trimmed per element.
                */}
                <span className="visually-hidden">- {STATUS_DESCRIPTION[status]}</span>
              </dt>
              <dd className="count__value">{metadata.counts[status].toLocaleString('en-GB')}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}
