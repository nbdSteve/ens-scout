import type { MouseEvent, ReactNode } from 'react'

export interface DiscoveryHeaderProps {
  readonly dataOpen: boolean
  readonly hasNotice: boolean
  readonly onOpenData: (event: MouseEvent<HTMLButtonElement>) => void
}

export function DiscoveryHeader({
  dataOpen,
  hasNotice,
  onOpenData,
}: DiscoveryHeaderProps): ReactNode {
  return (
    <header className="discovery-header">
      <a aria-label="ENS Scout home" className="brand" href="./">
        <span aria-hidden="true" className="brand__mark">
          <span />
        </span>
        <span>ENS Scout</span>
      </a>

      <nav aria-label="Site" className="discovery-header__actions">
        <button
          aria-controls="data-drawer"
          aria-expanded={dataOpen}
          className="header-action"
          onClick={onOpenData}
          type="button"
        >
          Data
          {hasNotice && <span aria-label="Data notices" className="header-action__notice" />}
        </button>
        <a
          className="header-action"
          href="https://app.ens.domains/"
          rel="noopener noreferrer"
          target="_blank"
        >
          ENS <span aria-hidden="true">↗</span>
          <span className="visually-hidden">, opens in a new tab</span>
        </a>
      </nav>
    </header>
  )
}
