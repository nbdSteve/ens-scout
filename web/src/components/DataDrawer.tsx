import { useEffect, useRef, type ReactNode, type RefObject } from 'react'

export interface DataDrawerProps {
  readonly children: ReactNode
  readonly open: boolean
  readonly onClose: () => void
  readonly returnFocusRef: RefObject<HTMLElement | null>
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

export function DataDrawer({
  children,
  open,
  onClose,
  returnFocusRef,
}: DataDrawerProps): ReactNode {
  const closeButton = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  const wasOpen = useRef(false)

  useEffect(() => {
    if (!open) {
      if (wasOpen.current) {
        wasOpen.current = false
        returnFocusRef.current?.focus()
      }
      return
    }

    wasOpen.current = true
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || panel.current === null) {
        return
      }
      const stops = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true',
      )
      const first = stops[0]
      const last = stops.at(-1)
      if (first === undefined || last === undefined) {
        return
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose, open, returnFocusRef])

  if (!open) {
    return null
  }

  return (
    <div className="drawer-backdrop">
      <aside
        aria-labelledby="data-drawer-title"
        aria-modal="true"
        className="data-drawer"
        id="data-drawer"
        ref={panel}
        role="dialog"
      >
        <div className="data-drawer__head">
          <div>
            <span className="data-drawer__eyebrow">Snapshot provenance</span>
            <h2 id="data-drawer-title">Data</h2>
          </div>
          <button
            aria-label="Close Data"
            className="drawer-close"
            onClick={onClose}
            ref={closeButton}
            type="button"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div className="data-drawer__body">{children}</div>
      </aside>
    </div>
  )
}
