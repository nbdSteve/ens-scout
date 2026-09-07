import type { ReactNode } from 'react'
import { ensAppUrl } from '../snapshot/lifecycle'

/**
 * The link out to the registry.
 *
 * This is the only authoritative destination on the page, so every name is one.
 * It opens in a new tab: a visitor who filtered a long list and then checked one
 * name should still have the filtered list when they come back, and the address
 * bar here holds exactly that list. The new tab is announced rather than sprung,
 * because an unannounced one is disorienting for anyone not watching the tab strip.
 *
 * The space between the name and the announcement is a text node of the link, not
 * the first character of the hidden span. An accessible name is assembled from each
 * child's own trimmed text, so a space inside the span is dropped and the result
 * reads as one run-together word.
 *
 * The announcement names ENS as the authority, and that is a requirement of every
 * outbound action rather than a nicety. Nothing this page shows is authoritative: the
 * snapshot is a record of a scan, and a fresh check is a re-read of an index. The one
 * place that decides whether a name can be registered is at the other end of this link,
 * and a visitor who is about to leave for it should have been told so.
 *
 * The rule about when the link may appear at all is `verify/gate.ts`, not here. This
 * component draws a link; whether a name has earned one is a judgement about evidence,
 * and it is deliberately not a decision any component can make locally.
 */
export interface EnsAppLinkProps {
  readonly name: string
}

export function EnsAppLink({ name }: EnsAppLinkProps): ReactNode {
  return (
    <a className="ens-link" href={ensAppUrl(name)} rel="noopener noreferrer" target="_blank">
      <span className="mono">{name}</span>{' '}
      <span className="visually-hidden">
        on the ENS app, which is the final authority on whether it can be registered, opens in a new
        tab
      </span>
    </a>
  )
}
