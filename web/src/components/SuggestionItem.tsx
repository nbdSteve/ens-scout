import type { ReactNode } from 'react'
import type { Suggestion } from '../suggest/shortlist'
import { EnsAppLink } from './EnsAppLink'
import { FreshCheckEvidence } from './FreshCheckEvidence'
import { rowVerifiedName, rowVerification, rowVerifyNote, type VerifyBinding } from './verification'

/**
 * One suggested name.
 *
 * A suggestion earns an outbound link exactly the way a scanned name does, through
 * `rowVerification` and therefore through `verify/gate.ts`: a fresh check has to cover the
 * name and still be current. There is no shortcut here and no way to ask for one. If
 * anything, a suggested name is less verified than a scanned one - it was chosen for how
 * it reads rather than for what the index said about it - so the same gate is the least
 * that can apply.
 *
 * The derivation is the same function the spatial field uses, not a copy of it. That matters more
 * than the few lines it saves: two per-name derivations would be two answers to the
 * question of whether a name may be acted on, and they would drift.
 *
 * The sentence beneath is fixed text from `shortlist.ts`, derived from the deterministic
 * scoring evidence. It is presented as a reason for the ranking and never as a statement
 * about the name's availability, because it is not one.
 */
export interface SuggestionItemProps {
  readonly suggestion: Suggestion
  /** Null when the deployment has no verifier, which is fixture mode. */
  readonly verify: VerifyBinding | null
  readonly now: Date
}

export function SuggestionItem({ suggestion, verify, now }: SuggestionItemProps): ReactNode {
  const row = verify === null ? null : rowVerification(suggestion.name, verify, now)
  const note = row === null ? null : rowVerifyNote(row)
  const checked = row === null ? null : rowVerifiedName(row)

  return (
    <li className="suggestion">
      {verify !== null && row !== null && (
        <label className="verify-box suggestion__pick">
          <input
            checked={row.selected}
            disabled={!row.selectable}
            onChange={() => {
              verify.onToggle(suggestion.name)
            }}
            type="checkbox"
          />
          <span className="visually-hidden">Fresh check {suggestion.name}</span>
        </label>
      )}
      <p className="suggestion__name">
        {row?.verdict.allowed === true ? (
          <EnsAppLink name={suggestion.name} />
        ) : (
          /*
           * Plain text rather than a disabled link, for the reason `NameCell` gives:
           * there is nowhere to go yet, so there is nothing to disable, and a greyed-out
           * link still reads as a link and still invites a click.
           */
          <span className="mono">{suggestion.name}</span>
        )}
        {note !== null && (
          <>
            {' '}
            <span className="suggestion__verify">{note}</span>
          </>
        )}
      </p>
      {checked !== null && <FreshCheckEvidence checked={checked} className="suggestion__fresh" />}
      <p className="suggestion__reason">{suggestion.reason}</p>
    </li>
  )
}
