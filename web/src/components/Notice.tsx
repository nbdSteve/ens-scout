import type { ReactNode } from 'react'

/**
 * A banner the visitor is meant to read before trusting what is under it.
 *
 * `tone` is only colour. What the banner means is always in its words, because a
 * visitor who cannot separate amber from blue, or who is reading the page through
 * a screen reader, gets nothing from the tone at all.
 *
 * `alert` puts the banner in a live region. It is set only for the warnings that
 * appear after the first render - a snapshot that turned out to be stale, a
 * network that dropped - and never for text that is present from the start, which
 * a screen reader will reach in document order anyway.
 */
export type NoticeTone = 'info' | 'warn' | 'danger'

export interface NoticeProps {
  readonly tone: NoticeTone
  readonly title: string
  readonly children: ReactNode
  readonly alert?: boolean
}

export function Notice({ tone, title, children, alert = false }: NoticeProps): ReactNode {
  return (
    <section
      className={`notice notice--${tone}`}
      {...(alert ? { role: 'alert' as const } : { 'aria-label': title })}
    >
      <h2 className="notice__title">{title}</h2>
      <div className="notice__body">{children}</div>
    </section>
  )
}
