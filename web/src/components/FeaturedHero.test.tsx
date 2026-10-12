import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { FeaturedSelection } from '../ranking/contract'
import type { VerifyBinding } from './verification'
import { FeaturedHero } from './FeaturedHero'

const NOW = new Date('2026-03-01T12:09:00Z')
const SELECTION: FeaturedSelection = {
  source: 'reviewed-artifact',
  desktop: [
    {
      name: 'vex.eth',
      label: 'vex',
      score: 990,
      facets: ['abstract_conceptual'],
      primaryFacet: 'abstract_conceptual',
    },
  ],
  mobile: [],
}

function binding(selected: ReadonlySet<string> = new Set()): VerifyBinding {
  return {
    selected,
    full: false,
    pending: new Set(),
    verified: new Map(),
    onToggle: () => undefined,
  }
}

describe('FeaturedHero', () => {
  it('renders the simplified semantic entrance and reserved loading geometry', () => {
    const { rerender } = render(
      <FeaturedHero
        availableCount={9126}
        checking={false}
        failure={null}
        now={NOW}
        onCheck={() => undefined}
        onDismissFailure={() => undefined}
        onExplore={() => undefined}
        selection={null}
        verify={binding()}
      />,
    )

    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName(
      'Featured available .eth names',
    )
    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('visually-hidden')
    expect(screen.queryByText(/available in the latest scan/)).not.toBeInTheDocument()
    expect(screen.queryByText(/The good ones are still out there/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Strong, memorable names/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Snapshot availability only/)).not.toBeInTheDocument()
    expect(document.querySelectorAll('.featured-map__skeleton')).toHaveLength(12)

    rerender(
      <FeaturedHero
        availableCount={9126}
        checking={false}
        failure={null}
        now={NOW}
        onCheck={() => undefined}
        onDismissFailure={() => undefined}
        onExplore={() => undefined}
        selection={SELECTION}
        verify={binding()}
      />,
    )
    expect(document.querySelector('.featured-hero')).toHaveAttribute(
      'data-featured-source',
      'reviewed-artifact',
    )
    expect(screen.getByRole('list', { name: /Featured available names/ })).toBeVisible()
  })

  it('checks only through the supplied shared action and preserves native discovery handoff', async () => {
    const onCheck = vi.fn()
    const onExplore = vi.fn((event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault()
    })
    render(
      <FeaturedHero
        availableCount={1}
        checking={false}
        failure={null}
        now={NOW}
        onCheck={onCheck}
        onDismissFailure={() => undefined}
        onExplore={onExplore}
        selection={SELECTION}
        verify={binding(new Set(['vex.eth']))}
      />,
    )

    await userEvent.setup().click(screen.getByRole('button', { name: 'Check 1 name' }))
    expect(onCheck).toHaveBeenCalledTimes(1)

    const explore = screen.getByRole('link', { name: /Explore all 1/ })
    expect(explore).toHaveAttribute('href', '#page-title')
    expect(explore.querySelector('.featured-hero__explore-arrow')).toHaveTextContent('↓')
    expect(explore.querySelector('.featured-hero__explore-arrow')).toHaveAttribute(
      'aria-hidden',
      'true',
    )
    fireEvent.click(explore)
    expect(onExplore).toHaveBeenCalledTimes(1)
  })

  it('keeps the check action closed without a verifier or selection', () => {
    const { rerender } = render(
      <FeaturedHero
        availableCount={1}
        checking={false}
        failure={null}
        now={NOW}
        onCheck={() => undefined}
        onDismissFailure={() => undefined}
        onExplore={() => undefined}
        selection={SELECTION}
        verify={null}
      />,
    )

    expect(screen.getByRole('button', { name: 'Select names to check' })).toBeDisabled()

    rerender(
      <FeaturedHero
        availableCount={1}
        checking={false}
        failure={null}
        now={NOW}
        onCheck={() => undefined}
        onDismissFailure={() => undefined}
        onExplore={() => undefined}
        selection={SELECTION}
        verify={binding()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Select names to check' })).toBeDisabled()
  })
})
