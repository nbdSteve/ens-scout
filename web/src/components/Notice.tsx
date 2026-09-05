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
 * render needs. `alert` interrupts, and is for something that appeared later and changes
 * what the rows below mean.
 *
 * `additions` announces a line that appears, politely, and says nothing when the wording
 * of a line already there changes. A band fed by a text box needs exactly that: `alert`
 * would interrupt the visitor on every digit they type, and `role="status"` is atomic, so
 * it would re-read the whole band each time a number inside it moved.
 */
export type NoticeVoice = 'silent' | 'alert' | 'additions'

export interface NoticeProps {
  readonly tone: NoticeTone
  readonly title: string
  readonly children: ReactNode
  readonly voice?: NoticeVoice
}

function voiceProps(voice: NoticeVoice, title: string): HTMLAttributes<HTMLElement> {
  if (voice === 'alert') {
    return { role: 'alert' }
  }
  if (voice === 'additions') {
    return {
      'aria-label': title,
      'aria-live': 'polite',
      'aria-atomic': false,
      'aria-relevant': 'additions',
    }
  }
  return { 'aria-label': title }
}

export function Notice({ tone, title, children, voice = 'silent' }: NoticeProps): ReactNode {
  return (
    <section className={`notice notice--${tone}`} {...voiceProps(voice, title)}>
      <h2 className="notice__title">{title}</h2>
      <div className="notice__body">{children}</div>
    </section>
  )
}
