import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SnapshotResult } from '../snapshot/types'
import { buildResults, SCANNED_AT } from '../test/factory'
import type { VerifiedName } from '../verify/types'
import { NameField } from './NameField'
import type { VerifyBinding } from './verification'

const ROWS = buildResults(['aura', 'bloom', 'cove'])
const CHECKED_AT = new Date('2026-03-01T12:00:00Z')
const EXPIRES_AT = new Date('2026-03-01T12:01:00Z')

function verifiedName(name: string): VerifiedName {
  return {
    result: {
      name,
      label: name.slice(0, -'.eth'.length),
      status: 'available',
      expiry: null,
      graceEnds: null,
      premiumEnds: null,
    },
    checkedAt: CHECKED_AT,
    expiresAt: EXPIRES_AT,
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

function mount(
  overrides: {
    rows?: readonly SnapshotResult[]
    showStatus?: boolean
    verify?: VerifyBinding | null
    now?: Date
  } = {},
): void {
  render(
    <NameField
      label="Available .eth names"
      now={overrides.now ?? SCANNED_AT}
      rows={overrides.rows ?? ROWS}
      showStatus={overrides.showStatus ?? false}
      transitionKey="available"
      verify={overrides.verify ?? null}
    />,
  )
}

function cell(name: string): HTMLElement {
  return screen.getByRole('listitem', { name: new RegExp(`^${name.replace('.', '\\.')}`) })
}

describe('NameField structure', () => {
  it('renders the supplied order as one named list with no table or row prose', () => {
    mount()

    const field = screen.getByRole('list', { name: 'Available .eth names' })
    expect(
      within(field)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining('aura.eth'),
      expect.stringContaining('bloom.eth'),
      expect.stringContaining('cove.eth'),
    ])
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(field.querySelector('p')).toBeNull()
  })

  it('states label length without counting the suffix and includes visible status when asked', () => {
    mount({
      rows: [
        {
          name: 'aura.eth',
          label: 'aura',
          status: 'premium',
          expiry: null,
          graceEnds: null,
          premiumEnds: null,
        },
      ],
      showStatus: true,
    })

    expect(cell('aura.eth')).toHaveAccessibleName('aura.eth, 4 characters, Premium')
    expect(within(cell('aura.eth')).getByText('4 chars')).toBeVisible()
    expect(within(cell('aura.eth')).getByText('Premium')).toBeVisible()
  })

  it('contains long labels instead of truncating the data contract', () => {
    const long = 'z'.repeat(64)
    mount({ rows: buildResults([long]) })

    expect(cell(`${long}.eth`)).toHaveTextContent(`${long}.eth`)
    expect(cell(`${long}.eth`)).toHaveTextContent('64 chars')
  })

  it('gives fixture cells a keyboard stop with the same focus target as hover', async () => {
    const user = userEvent.setup()
    mount()

    await user.tab()
    expect(cell('aura.eth')).toHaveFocus()
    await user.tab()
    expect(cell('bloom.eth')).toHaveFocus()
  })
})

describe('NameField deterministic presentation', () => {
  it('seeds each name with stable bounded bloom variables', () => {
    mount()
    const aura = cell('aura.eth')
    const first = aura.getAttribute('style')

    expect(first).toMatch(/--bloom-x: \d+%/)
    expect(first).toMatch(/--bloom-y: \d+%/)
    expect(first).toMatch(/--bloom-accent: #[0-9a-f]{6}/)
    expect(first).toMatch(/--entry-delay: \d+ms/)

    const bloomX = Number.parseInt(aura.style.getPropertyValue('--bloom-x'), 10)
    const bloomY = Number.parseInt(aura.style.getPropertyValue('--bloom-y'), 10)
    expect(bloomX).toBeGreaterThanOrEqual(14)
    expect(bloomX).toBeLessThanOrEqual(86)
    expect(bloomY).toBeGreaterThanOrEqual(12)
    expect(bloomY).toBeLessThanOrEqual(88)
  })
})

describe('NameField fresh-check behavior', () => {
  it('preserves selection, pending state, and the outbound evidence gate', async () => {
    const onToggle = vi.fn()
    mount({
      now: CHECKED_AT,
      verify: binding({
        selected: new Set(['aura.eth']),
        pending: new Set(['bloom.eth']),
        verified: new Map([['cove.eth', verifiedName('cove.eth')]]),
        onToggle,
      }),
    })

    const auraBox = within(cell('aura.eth')).getByRole('checkbox', {
      name: 'Fresh check aura.eth',
    })
    expect(auraBox).toBeChecked()
    expect(within(cell('bloom.eth')).getByText('Checking')).toBeVisible()

    const link = within(cell('cove.eth')).getByRole('link')
    expect(link).toHaveAttribute('href', 'https://app.ens.domains/cove.eth')
    expect(link).toHaveAccessibleName(/final authority/)

    await userEvent.setup().click(auraBox)
    expect(onToggle).toHaveBeenCalledWith('aura.eth')
  })

  it('removes the outbound link when fresh evidence lapses', () => {
    mount({
      now: EXPIRES_AT,
      verify: binding({
        verified: new Map([['aura.eth', verifiedName('aura.eth')]]),
      }),
    })

    expect(within(cell('aura.eth')).queryByRole('link')).not.toBeInTheDocument()
    expect(within(cell('aura.eth')).getByText('Fresh check lapsed')).toBeVisible()
    expect(within(cell('aura.eth')).getByText('Fresh check')).toBeVisible()
  })

  it('disables only unselected checkboxes at the selection bound', () => {
    mount({
      verify: binding({
        selected: new Set(['aura.eth']),
        full: true,
      }),
    })

    expect(within(cell('aura.eth')).getByRole('checkbox')).toBeEnabled()
    expect(within(cell('bloom.eth')).getByRole('checkbox')).toBeDisabled()
  })
})
