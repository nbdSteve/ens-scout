import type { ReactNode } from 'react'

/**
 * Text for a screen reader that would be redundant on screen.
 *
 * Used for the two things this page cannot express visually: the full wording
 * behind an abbreviated value, and a static description of a countdown whose
 * ticking digits are hidden from assistive technology. It is never used to hide
 * something a sighted visitor needs.
 */
export function VisuallyHidden({ children }: { readonly children: ReactNode }): ReactNode {
  return <span className="visually-hidden">{children}</span>
}
