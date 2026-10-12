import { resolveOutbound, type OutboundVerdict } from '../verify/gate'
import type { VerifiedName, VerifiedNames } from '../verify/types'

/**
 * What the spatial name field needs to know about fresh checks.
 *
 * The field is handed this or nothing. Nothing means the deployment has no verifier -
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

/** One name cell's share of it, decided once and read by its controls and evidence. */
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
 * What the name cell says about its own fresh check, or null when there is nothing to add.
 *
 * Fixed literals, because the only thing here that varies is a state this page decided
 * for itself. The instant of a check that did land is stated in the row's fresh evidence
 * instead, beside the status it produced, where the two belong together.
 *
 * The verified case says nothing: the link being there, and the fresh status beside it,
 * are the whole message, and a third line repeating it would cost space on the first
 * screen for no new fact.
 */
export function rowVerifyNote(row: RowVerification): string | null {
  if (row.pending) {
    return 'Fresh check running'
  }
  if (row.verdict.allowed) {
    return null
  }
  if (row.verdict.reason === 'expired') {
    return 'Fresh check has lapsed'
  }
  return row.verdict.reason === 'status-changed' ? 'Fresh status changed' : 'No fresh check'
}

export function rowVerifiedName(row: RowVerification): VerifiedName | null {
  if (row.verdict.allowed) {
    return row.verdict.verified
  }
  return row.verdict.reason === 'unverified' ? null : row.verdict.verified
}
