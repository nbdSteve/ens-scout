import type { ReactNode } from 'react'

/**
 * The first load, before there is anything to show.
 *
 * The spinner is decoration and is hidden from assistive technology; the status
 * text is the real announcement. It is `role="status"`, which is polite, rather
 * than an alert: a page that is loading normally is not something to interrupt
 * for. `prefers-reduced-motion` stops the spin without removing the message.
 */
export function LoadingState(): ReactNode {
  return (
    <div className="card state">
      <div aria-hidden="true" className="spinner" />
      <h2 className="state__title">Loading the snapshot</h2>
      <p className="prose" role="status">
        Reading the published scan. Nothing is being checked against ENS from your browser.
      </p>
    </div>
  )
}
