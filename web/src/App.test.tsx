import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { App } from './App'
import type { AppConfig } from './config/env'
import type { SnapshotDocument } from './snapshot/types'
import type { FeaturedNamesDeps } from './state/useFeaturedNames'
import type { SnapshotDeps } from './state/useSnapshot'
import { buildLatestDocument, buildSnapshotDocument, SCANNED_AT } from './test/factory'

const CONFIG: AppConfig = { apiBaseUrl: null, fixtureId: 'preview' }
const RANK_DOCUMENT = JSON.parse(
  readFileSync(resolve(process.cwd(), 'public/data/og-rank-v1.json'), 'utf8'),
) as unknown
const ALLOWLIST_DOCUMENT = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/data/featured-safe-v1.json'), 'utf8'),
) as unknown
const FEATURED_DEPS: FeaturedNamesDeps = {
  allowlistDocument: ALLOWLIST_DOCUMENT,
  loadRank: () => Promise.resolve(RANK_DOCUMENT),
}

const DOCUMENT = buildSnapshotDocument({
  results: [
    { name: 'aaa.eth', status: 'available' },
    { name: 'bbb.eth', status: 'available' },
    { name: 'ccc.eth', status: 'available' },
    { name: 'dddd.eth', status: 'registered', expiry: new Date('2027-01-01T00:00:00Z') },
    {
      name: 'eeee.eth',
      status: 'premium',
      expiry: new Date('2025-11-01T00:00:00Z'),
      graceEnds: new Date('2026-01-30T00:00:00Z'),
      premiumEnds: new Date('2026-03-20T00:00:00Z'),
    },
  ],
  sources: [
    { id: 'four-letters', path: 'data/words/4-letters.txt', cadence: 'three-hourly', names: 2 },
    { id: 'three-letters', path: 'data/words/3-letters.txt', cadence: 'daily', names: 3 },
  ],
})

function depsFor(document: SnapshotDocument = DOCUMENT): SnapshotDeps {
  return {
    loadFixture: () =>
      Promise.resolve({ snapshot: document, latest: buildLatestDocument(document) }),
    storage: null,
  }
}

const NOW = new Date(SCANNED_AT.getTime() + 60 * 60 * 1000)
const FEATURED_DOCUMENT = buildSnapshotDocument({
  results: [
    'dub',
    'eon',
    'fuzz',
    'hex',
    'jinx',
    'jolt',
    'midi',
    'moth',
    'rune',
    'saga',
    'zero',
    'zine',
  ].map((label) => ({ name: `${label}.eth`, status: 'available' as const })),
  sources: [
    { id: 'four-letters', path: 'data/words/4-letters.txt', cadence: 'daily', names: 9 },
    { id: 'three-letters', path: 'data/words/3-letters.txt', cadence: 'daily', names: 3 },
  ],
})

async function mount(
  search = `?now=${NOW.toISOString().slice(0, 19)}Z`,
  document: SnapshotDocument = DOCUMENT,
): Promise<void> {
  window.history.replaceState(null, '', `/${search}`)
  render(<App config={CONFIG} deps={depsFor(document)} />)
  await screen.findByRole('list', { name: /\.eth names$/ })
}

async function mountDefault(
  featuredDeps: FeaturedNamesDeps = FEATURED_DEPS,
  document: SnapshotDocument = FEATURED_DOCUMENT,
): Promise<void> {
  window.history.replaceState(null, '', '/')
  render(<App config={CONFIG} deps={depsFor(document)} featuredDeps={featuredDeps} />)
  await screen.findByRole('list', { name: 'Featured available names, best first' })
}

function nameList(): HTMLElement {
  return screen.getByRole('list', { name: /\.eth names$/ })
}

async function openData(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  const header = screen.getByRole('banner')
  const trigger = within(header).getByRole('button', { name: /Data/ })
  await user.click(trigger)
  return screen.getByRole('dialog', { name: 'Data' })
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('ENS Spectrum discovery path', () => {
  it('opens the canonical Available route with one ranked hero before discovery', async () => {
    await mountDefault()

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName(
      'The good ones are still out there.',
    )
    expect(screen.getByRole('heading', { level: 2, name: 'Available .eth names' })).toBeVisible()
    expect(
      within(
        screen.getByRole('list', { name: 'Featured available names, best first' }),
      ).getAllByRole('listitem'),
    ).toHaveLength(12)
    expect(document.querySelector('.featured-hero')).toHaveAttribute(
      'data-featured-source',
      'reviewed-artifact',
    )
  })

  it('uses the safe fallback for a refused rank and omits the hero for a refused policy', async () => {
    const { unmount } = render(
      <App
        config={CONFIG}
        deps={depsFor(FEATURED_DOCUMENT)}
        featuredDeps={{
          allowlistDocument: ALLOWLIST_DOCUMENT,
          loadRank: () => Promise.resolve(null),
        }}
      />,
    )
    await screen.findByRole('list', { name: 'Featured available names, best first' })
    expect(document.querySelector('.featured-hero')).toHaveAttribute(
      'data-featured-source',
      'deterministic-fallback',
    )

    unmount()
    window.history.replaceState(null, '', '/')
    render(
      <App
        config={CONFIG}
        deps={depsFor(FEATURED_DOCUMENT)}
        featuredDeps={{
          allowlistDocument: null,
          loadRank: () => Promise.resolve(RANK_DOCUMENT),
        }}
      />,
    )
    await screen.findByRole('list', { name: 'Available .eth names' })
    expect(document.querySelector('.featured-hero')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('Available .eth names')
  })

  it('lands on Available, renders names as a list, and contains no table', async () => {
    await mount()

    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('Available .eth names')
    expect(screen.getByRole('link', { name: /^Available 3 names match/ })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(nameList()).getAllByRole('listitem')).toHaveLength(3)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('keeps the main discovery surface terse and free of row prose', async () => {
    await mount()

    expect(document.querySelector('.discovery p')).toBeNull()
    expect(document.querySelector('#results p')).toBeNull()
    expect(document.querySelector('.trustline')).toBeNull()
    expect(document.querySelector('footer')).toBeNull()
    expect(screen.queryByText(/What happens next/)).not.toBeInTheDocument()
  })

  it('keeps Available canonical as the absence of a view parameter', async () => {
    await mount()
    const params = new URLSearchParams(window.location.search)
    expect(params.get('view')).toBeNull()
    expect(params.get('now')).toBe(`${NOW.toISOString().slice(0, 19)}Z`)
  })

  it('puts search, lifecycle, Length, and More in one compact filter region', async () => {
    await mount()
    const filters = screen.getByRole('region', { name: 'Filter names' })

    expect(within(filters).getByRole('searchbox', { name: 'Search names' })).toBeVisible()
    expect(within(filters).getByRole('navigation', { name: 'Views' })).toBeVisible()
    expect(within(filters).getByText('Length')).toBeVisible()
    expect(within(filters).getByText('More')).toBeVisible()
  })

  it('uses the snapshot strip for preview time, ENS verification, and Data', async () => {
    await mount()

    expect(screen.getByText('Preview', { exact: false })).toHaveTextContent('Preview · Mar 1')
    expect(screen.getByRole('link', { name: /Verify on ENS/ })).toHaveAttribute(
      'href',
      'https://app.ens.domains/',
    )
    expect(screen.getAllByRole('button', { name: /Data/ })).toHaveLength(2)
  })
})

describe('Data drawer', () => {
  it('is closed by default, opens accessibly, and restores focus when closed', async () => {
    const user = userEvent.setup()
    await mount()
    const trigger = within(screen.getByRole('banner')).getByRole('button', { name: /Data/ })

    expect(screen.queryByRole('dialog', { name: 'Data' })).not.toBeInTheDocument()
    await user.click(trigger)
    const drawer = screen.getByRole('dialog', { name: 'Data' })
    expect(drawer).toBeVisible()
    expect(within(drawer).getByRole('button', { name: 'Close Data' })).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Data' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('moves preview-clock explanation and provenance behind Data', async () => {
    const user = userEvent.setup()
    await mount()

    expect(screen.queryByText('Preview clock')).not.toBeInTheDocument()
    const drawer = await openData(user)
    expect(within(drawer).getByText('Preview clock')).toBeVisible()
    expect(within(drawer).getByRole('link', { name: 'Use the real time instead' })).toHaveAttribute(
      'href',
      './',
    )
    expect(within(drawer).getByRole('heading', { name: 'Scan' })).toBeVisible()
    expect(within(drawer).getByRole('heading', { name: 'What each status means' })).toBeVisible()
  })

  it('keeps rejected URL values out of the field and explains them in Data', async () => {
    const user = userEvent.setup()
    await mount(`?view=nope&now=${NOW.toISOString().slice(0, 19)}Z`)

    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('Available .eth names')
    expect(screen.queryByText('Not applied')).not.toBeInTheDocument()
    const drawer = await openData(user)
    expect(within(drawer).getByText('Not applied')).toBeVisible()
    expect(drawer).toHaveTextContent(
      'The link asked for an unknown view, so Available .eth names is shown instead.',
    )
  })

  it('explains an unattributable list filter without replacing the names', async () => {
    const user = userEvent.setup()
    const unattributable: SnapshotDocument = {
      ...DOCUMENT,
      metadata: {
        ...DOCUMENT.metadata,
        sources: [
          {
            id: 'wordlist',
            path: 'data/words/wordlist.txt',
            cadence: 'daily',
            names: 5,
            last_scanned_at: DOCUMENT.metadata.scanned_at,
          },
        ],
      },
    }
    await mount(
      `?view=all&list=four-letters&now=${NOW.toISOString().slice(0, 19)}Z`,
      unattributable,
    )

    expect(within(nameList()).getAllByRole('listitem')).toHaveLength(5)
    const drawer = await openData(user)
    expect(drawer).toHaveTextContent('List filter not applied')
    expect(drawer).toHaveTextContent('so the full view is shown')
  })
})

describe('keyboard order', () => {
  it('starts with a skip link that targets the discovery heading', async () => {
    const user = userEvent.setup()
    await mount()

    await user.tab()
    const skip = screen.getByRole('link', { name: 'Skip to the names' })
    expect(skip).toHaveFocus()
    expect(skip).toHaveAttribute('href', '#page-title')
    expect(screen.getByRole('region', { name: 'Available .eth names' })).toHaveAttribute(
      'id',
      'results',
    )
  })

  it('calls the first-focus link Skip featured names on the canonical route', async () => {
    const user = userEvent.setup()
    await mountDefault()

    await user.tab()
    expect(screen.getByRole('link', { name: 'Skip featured names' })).toHaveFocus()
  })
})
