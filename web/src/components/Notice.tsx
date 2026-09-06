import type { HTMLAttributes, ReactNode } from 'react'

/**
 * A banner the visitor is meant to read before trusting what is under it.
 *
 * `tone` is only colour. What the banner means is always in its words, because a
 * visitor who cannot separate amber from blue, or who is reading the page through
 * a screen reader, gets nothing from the tone at all.
 */
export type NoticeTone = 'info' | 'warn' | 'danger'

/**
 * How the banner reaches a screen reader.
 *
 * `silent` is reached in document order, which is all that text present from the first
 * render needs, and all a banner needs when something around it is already a live region.
 * `alert` interrupts, and is for something that appeared later and changes what the rows
 * below mean.
 *
 * A banner cannot carry a polite region of its own: one that is rendered only when it has
 * something to say enters the DOM together with its first line, and a live region created
 * with its content is the case where nothing is announced. The polite region therefore
 * lives on the advisories block, which is always mounted.
 */
export type NoticeVoice = 'silent' | 'alert'

export interface NoticeProps {
  readonly tone: NoticeTone
  readonly title: string
  readonly children: ReactNode
  readonly voice?: NoticeVoice
}

function voiceProps(voice: NoticeVoice, title: string): HTMLAttributes<HTMLElement> {
  return voice === 'alert' ? { role: 'alert' } : { 'aria-label': title }
}

export function Notice({ tone, title, children, voice = 'silent' }: NoticeProps): ReactNode {
  return (
    <section className={`notice notice--${tone}`} {...voiceProps(voice, title)}>
      <h2 className="notice__title">{title}</h2>
      <div className="notice__body">{children}</div>
    </section>
  )
}
