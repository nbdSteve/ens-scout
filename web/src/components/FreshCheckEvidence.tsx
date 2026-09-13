import type { ReactNode } from 'react'
import { splitAbsolute, toIsoSecond } from '../format/time'
import type { VerifiedName } from '../verify/types'
import { StatusPill } from './StatusPill'

export interface FreshCheckEvidenceProps {
  readonly checked: VerifiedName
  readonly className: string
}

export function FreshCheckEvidence({ checked, className }: FreshCheckEvidenceProps): ReactNode {
  return (
    <span className={className}>
      <span className="fresh-check__label">
        Fresh check{' '}
        <time className="mono" dateTime={toIsoSecond(checked.checkedAt)}>
          {splitAbsolute(checked.checkedAt).clock}
        </time>
      </span>
      <StatusPill status={checked.result.status} />
    </span>
  )
}
