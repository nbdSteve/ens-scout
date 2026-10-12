import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import type { FeaturedName } from '../ranking/contract'
import { FEATURED_SLOTS, featuredLayout } from '../ranking/layout'
import { nameVisual } from '../state/nameVisual'
import { EnsAppLink } from './EnsAppLink'
import { FreshCheckEvidence } from './FreshCheckEvidence'
import { rowVerifiedName, rowVerification, rowVerifyNote, type VerifyBinding } from './verification'

type FeaturedStyle = CSSProperties & {
  '--slot-x': string
  '--slot-y': string
  '--slot-width': string
  '--tier-font': string
  '--font-cap': string
  '--bloom-x': string
  '--bloom-y': string
  '--bloom-accent': string
  '--entry-delay': string
}

type SkeletonStyle = CSSProperties & {
  '--slot-x': string
  '--slot-y': string
  '--slot-width': string
}

export interface FeaturedNameMapProps {
  readonly names: readonly FeaturedName[]
  readonly now: Date
  readonly verify: VerifyBinding | null
}

function selectionLabel(name: FeaturedName): string {
  return `Select ${name.name}, snapshot available`
}

function FeaturedControl({
  name,
  now,
  rank,
  verify,
}: {
  readonly name: FeaturedName
  readonly now: Date
  readonly rank: number
  readonly verify: VerifyBinding | null
}): ReactNode {
  const layout = featuredLayout(name.label, rank)
  const visual = nameVisual(name.name)
  const row = verify === null ? null : rowVerification(name.name, verify, now)
  const checked = row === null ? null : rowVerifiedName(row)
  const note = row === null ? null : rowVerifyNote(row)
  const visibleNote = note === 'No fresh check' ? null : note
  const style: FeaturedStyle = {
    '--slot-x': `${String(layout.slot.xPercent)}%`,
    '--slot-y': `${String(layout.slot.yPercent)}%`,
    '--slot-width': `${String(layout.slot.widthPercent)}%`,
    '--tier-font': `${String(layout.tierMaxPx)}px`,
    '--font-cap': `${layout.fontCapCqw.toFixed(3)}cqw`,
    '--bloom-x': `${String(visual.xPercent)}%`,
    '--bloom-y': `${String(visual.yPercent)}%`,
    '--bloom-accent': visual.accent,
    '--entry-delay': `${String(Math.min(rank - 1, 7) * 34)}ms`,
  }
  const evidenceId = `featured-evidence-${name.label}`

  return (
    <li
      aria-busy={row?.pending === true ? 'true' : undefined}
      className="featured-name"
      data-rank={rank}
      data-selected={row?.selected === true ? 'true' : 'false'}
      data-tier={layout.slot.tier}
      style={style}
    >
      {verify === null || row === null ? (
        <div
          aria-label={`${name.name}, snapshot available`}
          className="featured-name__control featured-name__control--static"
          role="group"
        >
          <span className="featured-name__label">
            <span>{name.label}</span>
            <span className="featured-name__suffix">.eth</span>
          </span>
        </div>
      ) : (
        <label className="featured-name__control">
          <input
            aria-describedby={checked === null && visibleNote === null ? undefined : evidenceId}
            aria-label={selectionLabel(name)}
            checked={row.selected}
            disabled={!row.selectable}
            onChange={() => {
              verify.onToggle(name.name)
            }}
            type="checkbox"
          />
          <span className="featured-name__label">
            <span>{name.label}</span>
            <span className="featured-name__suffix">.eth</span>
          </span>
          <span aria-hidden="true" className="featured-name__check">
            ✓
          </span>
        </label>
      )}

      {(checked !== null || visibleNote !== null) && (
        <div className="featured-name__evidence" id={evidenceId}>
          {checked !== null && (
            <FreshCheckEvidence checked={checked} className="featured-name__fresh" />
          )}
          {row?.verdict.allowed === true && (
            <EnsAppLink className="featured-name__outbound" name={name.name}>
              Open in ENS <span aria-hidden="true">↗</span>
            </EnsAppLink>
          )}
          {visibleNote !== null && <span className="featured-name__note">{visibleNote}</span>}
        </div>
      )}
    </li>
  )
}

export function FeaturedMapSkeleton(): ReactNode {
  return (
    <div aria-hidden="true" className="featured-map featured-map--loading">
      {FEATURED_SLOTS.map((slot) => {
        const style: SkeletonStyle = {
          '--slot-x': `${String(slot.xPercent)}%`,
          '--slot-y': `${String(slot.yPercent)}%`,
          '--slot-width': `${String(slot.widthPercent)}%`,
        }
        return <span className="featured-map__skeleton" key={slot.rank} style={style} />
      })}
    </div>
  )
}

export function FeaturedNameMap({ names, now, verify }: FeaturedNameMapProps): ReactNode {
  const field = useRef<HTMLOListElement>(null)

  useEffect(() => {
    const node = field.current
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (node === null || reduced.matches) {
      return
    }

    let frame = 0
    let x = 50
    let y = 42
    const write = (): void => {
      frame = 0
      node.style.setProperty('--pointer-x', `${x.toFixed(2)}%`)
      node.style.setProperty('--pointer-y', `${y.toFixed(2)}%`)
    }
    const queue = (): void => {
      if (frame === 0) {
        frame = window.requestAnimationFrame(write)
      }
    }
    const onPointerMove = (event: PointerEvent): void => {
      const box = node.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) {
        return
      }
      x = ((event.clientX - box.left) / box.width) * 100
      y = ((event.clientY - box.top) / box.height) * 100
      queue()
    }
    const onPointerLeave = (): void => {
      x = 50
      y = 42
      queue()
    }

    node.addEventListener('pointermove', onPointerMove)
    node.addEventListener('pointerleave', onPointerLeave)
    return () => {
      node.removeEventListener('pointermove', onPointerMove)
      node.removeEventListener('pointerleave', onPointerLeave)
      if (frame !== 0) {
        window.cancelAnimationFrame(frame)
      }
    }
  }, [])

  return (
    <ol aria-label="Featured available names" className="featured-map" ref={field}>
      {names.map((name, index) => (
        <FeaturedControl key={name.name} name={name} now={now} rank={index + 1} verify={verify} />
      ))}
    </ol>
  )
}
