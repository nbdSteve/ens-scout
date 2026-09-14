import { useEffect, useRef, type ReactNode } from 'react'
import type { SnapshotResult } from '../snapshot/types'
import type { VerifyBinding } from './verification'
import { NameCell } from './NameCell'

export interface NameFieldProps {
  readonly label: string
  readonly now: Date
  readonly rows: readonly SnapshotResult[]
  readonly showStatus: boolean
  readonly transitionKey: string
  readonly verify: VerifyBinding | null
}

export function NameField({
  label,
  now,
  rows,
  showStatus,
  transitionKey,
  verify,
}: NameFieldProps): ReactNode {
  const field = useRef<HTMLOListElement>(null)

  useEffect(() => {
    const node = field.current
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (node === null || reduced.matches) {
      return
    }

    let frame = 0
    let x = 50
    let y = 22
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
      y = 22
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
    <ol aria-label={label} className="name-field" ref={field}>
      {rows.map((result) => (
        <NameCell
          key={`${transitionKey}:${result.name}`}
          now={now}
          result={result}
          showStatus={showStatus}
          verify={verify}
        />
      ))}
    </ol>
  )
}
