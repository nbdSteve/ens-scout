import type { CSSProperties, ReactNode } from 'react'
import { STATUS_LABEL } from '../snapshot/lifecycle'
import type { SnapshotResult } from '../snapshot/types'
import { labelLength } from '../state/filter'
import { nameVisual } from '../state/nameVisual'
import { EnsAppLink } from './EnsAppLink'
import { FreshCheckEvidence } from './FreshCheckEvidence'
import { rowVerifiedName, rowVerification, rowVerifyNote, type VerifyBinding } from './verification'

type SeedStyle = CSSProperties & {
  '--bloom-x': string
  '--bloom-y': string
  '--bloom-accent': string
  '--entry-delay': string
}

export interface NameCellProps {
  readonly now: Date
  readonly result: SnapshotResult
  readonly showStatus: boolean
  readonly verify: VerifyBinding | null
}

function NameLabel({ result }: { readonly result: SnapshotResult }): ReactNode {
  return (
    <span className="name-cell__label">
      <span className="name-cell__stem">{result.label}</span>
      <span className="name-cell__suffix">.eth</span>
    </span>
  )
}

export function NameCell({ now, result, showStatus, verify }: NameCellProps): ReactNode {
  const visual = nameVisual(result.name)
  const length = labelLength(result)
  const row = verify === null ? null : rowVerification(result.name, verify, now)
  const checked = row === null ? null : rowVerifiedName(row)
  const note = row === null ? null : rowVerifyNote(row)
  const style: SeedStyle = {
    '--bloom-x': `${String(visual.xPercent)}%`,
    '--bloom-y': `${String(visual.yPercent)}%`,
    '--bloom-accent': visual.accent,
    '--entry-delay': `${String(visual.delayMs)}ms`,
  }

  return (
    // A fixture has no outbound action, but the cell still needs the same keyboard
    // feedback as hover. In verifier builds the checkbox and eventual link supply it.
    <li
      aria-label={`${result.name}, ${String(length)} ${
        length === 1 ? 'character' : 'characters'
      }${showStatus ? `, ${STATUS_LABEL[result.status]}` : ''}`}
      className="name-cell"
      style={style}
      tabIndex={verify === null ? 0 : undefined}
    >
      {verify !== null && row !== null && (
        <label className="name-cell__select">
          <input
            checked={row.selected}
            disabled={!row.selectable}
            onChange={() => {
              verify.onToggle(result.name)
            }}
            type="checkbox"
          />
          <span aria-hidden="true" className="name-cell__select-mark" />
          <span className="visually-hidden">Fresh check {result.name}</span>
        </label>
      )}

      <div className="name-cell__surface">
        {row?.verdict.allowed === true ? (
          <EnsAppLink className="name-cell__action" name={result.name}>
            <NameLabel result={result} />
            <span aria-hidden="true" className="name-cell__arrow">
              ↗
            </span>
          </EnsAppLink>
        ) : (
          <div className="name-cell__action">
            <NameLabel result={result} />
            <span aria-hidden="true" className="name-cell__arrow">
              ↗
            </span>
          </div>
        )}

        <div className="name-cell__meta">
          <span>
            {length} {length === 1 ? 'char' : 'chars'}
          </span>
          {showStatus && <span className="name-cell__status">{STATUS_LABEL[result.status]}</span>}
          {row?.pending === true && <span className="name-cell__fresh-note">Checking</span>}
          {note === 'Fresh check has lapsed' && (
            <span className="name-cell__fresh-note">Fresh check lapsed</span>
          )}
          {note === 'Fresh status changed' && (
            <span className="name-cell__fresh-note">Fresh status changed</span>
          )}
        </div>

        {checked !== null && <FreshCheckEvidence checked={checked} className="name-cell__fresh" />}
      </div>
    </li>
  )
}
