import type { ReactNode } from 'react'

/**
 * No rows to show.
 *
 * The two reasons are kept apart, because they need different actions. Filters that
 * match nothing are the visitor's own doing and are recoverable, so the way out is
 * offered. A view that is genuinely empty in this snapshot is a fact about the data,
 * and offering to clear filters there would be misleading.
 */
export interface EmptyStateProps {
  readonly filtered: boolean
  readonly viewLabel: string
  readonly resetHref: string
}

export function EmptyState({ filtered, viewLabel, resetHref }: EmptyStateProps): ReactNode {
  return (
    <div className="state">
      <h3 className="state__title">No names to show</h3>
      {filtered ? (
        <>
          <p className="prose">
            Nothing in <strong>{viewLabel}</strong> matches the current search, length range,
            status, and list. Widening any one of them will bring rows back.
          </p>
          <p>
            <a href={resetHref}>Clear all filters</a>
          </p>
        </>
      ) : (
        <p className="prose">
          This snapshot recorded no names in <strong>{viewLabel}</strong>. A later scan may, since
          names move between states as registrations expire.
        </p>
      )}
    </div>
  )
}
