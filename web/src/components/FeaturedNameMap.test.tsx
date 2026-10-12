import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Facet, FeaturedName } from '../ranking/contract'
import type { VerifiedName } from '../verify/types'
import { FeaturedNameMap } from './FeaturedNameMap'
import type { VerifyBinding } from './verification'

const NOW = new Date('2026-03-01T12:00:00Z')
const EXPIRES = new Date('2026-03-01T12:02:00Z')
const FACETS: readonly Facet[] = ['abstract_conceptual']

function featured(label: string, score: number): FeaturedName {
  return {
    name: `${label}.eth`,
    label,
    score,
    facets: FACETS,
    primaryFacet: 'abstract_conceptual',
  }
}

const NAMES = [
  featured('flux', 990),
  featured('nova', 990),
  featured('zine', 990),
  featured('hex', 980),
  featured('midi', 980),
  featured('vex', 980),
  featured('dub', 970),
  featured('rune', 970),
] as const

function verified(name: string, status: VerifiedName['result']['status']): VerifiedName {
  return {
    result: {
      name,
      label: name.slice(0, -'.eth'.length),
      status,
      expiry: status === 'registered' ? new Date('2027-03-01T12:00:00Z') : null,
      graceEnds: null,
      premiumEnds: null,
    },
    checkedAt: NOW,
    expiresAt: EXPIRES,
  }
}

function binding(overrides: Partial<VerifyBinding> = {}): VerifyBinding {
  return {
    selected: new Set<string>(),
    full: false,
    pending: new Set<string>(),
    verified: new Map<string, VerifiedName>(),
    onToggle: () => undefined,
    ...overrides,
  }
}

describe('FeaturedNameMap', () => {
  it('keeps DOM and focus order in rank order regardless of spatial slots', async () => {
    const user = userEvent.setup()
    render(<FeaturedNameMap names={NAMES} now={NOW} verify={binding()} />)

    const list = screen.getByRole('list', { name: 'Featured available names' })
    expect(
      within(list)
        .getAllByRole('checkbox')
        .map((box) => box.getAttribute('aria-label')),
    ).toEqual([
      'Select flux.eth, snapshot available',
      'Select nova.eth, snapshot available',
      'Select zine.eth, snapshot available',
      'Select hex.eth, snapshot available',
      'Select midi.eth, snapshot available',
      'Select vex.eth, snapshot available',
      'Select dub.eth, snapshot available',
      'Select rune.eth, snapshot available',
    ])
    expect(document.querySelector('.featured-name__rank, .featured-name__facet')).toBeNull()
    expect(list).not.toHaveTextContent('abstract + conceptual')

    await user.tab()
    expect(within(list).getAllByRole('checkbox')[0]).toHaveFocus()
    await user.tab()
    expect(within(list).getAllByRole('checkbox')[1]).toHaveFocus()
  })

  it('uses one native checkbox selection and exposes a visible checked state', async () => {
    const onToggle = vi.fn()
    const { rerender } = render(
      <FeaturedNameMap names={NAMES} now={NOW} verify={binding({ onToggle })} />,
    )
    const box = screen.getByRole('checkbox', {
      name: 'Select flux.eth, snapshot available',
    })

    await userEvent.setup().click(box)
    expect(onToggle).toHaveBeenCalledWith('flux.eth')

    rerender(
      <FeaturedNameMap
        names={NAMES}
        now={NOW}
        verify={binding({ selected: new Set(['flux.eth']), onToggle })}
      />,
    )
    expect(box).toBeChecked()
    expect(box.closest('.featured-name')).toHaveAttribute('data-selected', 'true')
    expect(box.parentElement?.querySelector('.featured-name__check')).toHaveTextContent('✓')
  })

  it('shares current evidence with the outbound gate and blocks a changed status', () => {
    render(
      <FeaturedNameMap
        names={NAMES}
        now={NOW}
        verify={binding({
          verified: new Map([
            ['flux.eth', verified('flux.eth', 'available')],
            ['nova.eth', verified('nova.eth', 'registered')],
          ]),
        })}
      />,
    )

    const flux = screen.getByRole('checkbox', { name: /flux\.eth/ }).closest('.featured-name')
    const nova = screen.getByRole('checkbox', { name: /nova\.eth/ }).closest('.featured-name')
    expect(flux).not.toBeNull()
    expect(nova).not.toBeNull()
    expect(within(flux as HTMLElement).getByRole('link')).toHaveAttribute(
      'href',
      'https://app.ens.domains/flux.eth',
    )
    expect(within(nova as HTMLElement).queryByRole('link')).not.toBeInTheDocument()
    expect(within(nova as HTMLElement).getByText('Registered')).toBeVisible()
    expect(within(nova as HTMLElement).getByText('Fresh status changed')).toBeVisible()
  })

  it('contains 32- and 64-character synthetic labels in the same fixed slots', () => {
    const longNames = [featured('y'.repeat(32), 990), featured('z'.repeat(64), 980)]
    render(<FeaturedNameMap names={longNames} now={NOW} verify={binding()} />)

    const items = screen.getAllByRole('listitem')
    expect(items[0]).toHaveStyle({ '--slot-x': '31%', '--slot-width': '38%' })
    expect(items[1]).toHaveStyle({ '--slot-x': '2%', '--slot-width': '27%' })
    expect(items[0]?.style.getPropertyValue('--font-cap')).not.toBe('')
    expect(items[1]?.style.getPropertyValue('--font-cap')).not.toBe('')
  })

  it('renders no checkbox or outbound link when the deployment has no verifier', () => {
    render(<FeaturedNameMap names={NAMES} now={NOW} verify={null} />)

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getAllByRole('group')).toHaveLength(NAMES.length)
  })
})
