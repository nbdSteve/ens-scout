import { resolveOutbound, type OutboundVerdict } from '../verify/gate'
import type { VerifiedNames } from '../verify/types'

/**
 * What the results table needs to know about fresh checks.
 *
 * The table is handed this or nothing. Nothing means the deployment has no verifier -
 * fixture mode - and then there are no tick boxes and no outbound links at all, because
 * a link the gate cannot judge is a link this page cannot stand behind.
 */
export interface VerifyBinding {
  readonly selected: ReadonlySet<string>
  /** True once the selection holds as many names as one check covers. */
  readonly full: boolean
  readonly pending: ReadonlySet<string>
  readonly verified: VerifiedNames
  readonly onToggle: (name: string) => void
}

/** One row's share of it, decided once per row and read by both cells. */
export interface RowVerification {
  readonly selected: boolean
  /** False when this row is unticked and the selection is already full. */
  readonly selectable: boolean
  readonly pending: boolean
  readonly verdict: OutboundVerdict
}

export function rowVerification(name: string, binding: VerifyBinding, now: Date): RowVerification {
  const selected = binding.selected.has(name)
  return {
    selected,
    selectable: selected || !binding.full,
    pending: binding.pending.has(name),
    verdict: resolveOutbound(name, binding.verified, now),
  }
}

/**
 * What the row says about its own fresh check, or null when there is nothing to add.
 *
 * Fixed literals, because the only thing here that varies is a state this page decided
 * for itself. The instant of a check that did land is stated in the status cell instead,
 * beside the status it produced, where the two belong together.
 *
 * The verified case says nothing: the link being there, and the fresh status beside it,
 * are the whole message, and a third line repeating it would cost a row on the first
 * screen for no new fact.
 */
export function rowVerifyNote(row: RowVerification): string | null {
  if (row.pending) {
    return 'Fresh check running'
  }
  if (row.verdict.allowed) {
    return null
  }
  return row.verdict.reason === 'expired' ? 'Fresh check has lapsed' : 'No fresh check'
}
