import type { MouseEvent, ReactNode } from 'react'

export interface FloatingDataButtonProps {
  readonly dataOpen: boolean
  readonly hasNotice: boolean
  readonly onOpenData: (event: MouseEvent<HTMLButtonElement>) => void
}

export function FloatingDataButton({
  dataOpen,
  hasNotice,
  onOpenData,
}: FloatingDataButtonProps): ReactNode {
  return (
    <>
      {hasNotice && (
        <span className="visually-hidden" id="floating-data-notice">
          Data notices available
        </span>
      )}
      <button
        aria-controls="data-drawer"
        aria-describedby={hasNotice ? 'floating-data-notice' : undefined}
        aria-expanded={dataOpen}
        className="floating-data"
        onClick={onOpenData}
        type="button"
      >
        Data
        {hasNotice && <span aria-hidden="true" className="floating-data__notice" />}
      </button>
    </>
  )
}
