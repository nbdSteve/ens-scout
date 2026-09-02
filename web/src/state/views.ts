import type { Status } from '../snapshot/contract'

/**
 * The named views.
 *
 * A view is a preset over the published statuses and nothing more. It does not
 * reclassify anything: `available` shows the names `ens.Classify` called
 * available, and `premium` shows the ones it called premium. Each view also
 * carries the sort that makes it useful on arrival - a premium list is worth
 * reading by when the premium ends, an expiring list by when it expires - so the
 * first screen is already ordered by the thing the visitor came for.
 *
 * Each view names itself twice. `label` is the short word on its tab, where five
 * of them share one row; `title` is the page's `<h1>`, where the reader has no tab
 * bar for context and needs to be told what kind of name this is a list of.
 */

export type SortId = 'name' | 'expiry' | 'grace-end' | 'premium-end'

export type SortDirection = 'asc' | 'desc'

export interface ViewDefinition {
  readonly id: string
  /** The short name on the view's own tab. */
  readonly label: string
  /** The page heading, which has to stand on its own away from the tabs. */
  readonly title: string
  /** What the view is for, shown in the disclosure and as the tab's description. */
  readonly summary: string
  /** Statuses the view admits. An empty list admits every status. */
  readonly statuses: readonly Status[]
  readonly defaultSort: SortId
}

/**
 * The view a visitor gets with no view named, and the fallback for a link that
 * names one this build does not have. It is a named constant so the fallback
 * needs no cast: there is no way for the default view to be missing.
 *
 * It is `available` rather than `all` because that is the question the page
 * exists to answer. Landing on every name in the snapshot makes the reader do the
 * filtering the scanner already did for them, and `?view=all` is one tab away.
 */
export const DEFAULT_VIEW: ViewDefinition = {
  id: 'available',
  label: 'Available',
  title: 'Available .eth names',
  summary: 'Released with no temporary premium at the scan time.',
  statuses: ['available'],
  defaultSort: 'name',
}

export const VIEWS: readonly ViewDefinition[] = [
  DEFAULT_VIEW,
  {
    id: 'premium',
    label: 'Premium',
    title: 'Premium .eth names',
    summary: 'Open to anyone, with a temporary premium still on the price. Soonest to clear first.',
    statuses: ['premium'],
    defaultSort: 'premium-end',
  },
  {
    id: 'expiring',
    label: 'Expiring',
    title: 'Expiring .eth names',
    summary: 'Still registered, but close to expiry at the scan time. Soonest to expire first.',
    statuses: ['expiring-soon'],
    defaultSort: 'expiry',
  },
  {
    id: 'grace',
    label: 'Grace period',
    title: 'Grace period .eth names',
    summary:
      'Expired and owner-only until the grace period ends. Soonest to leave the grace period first.',
    statuses: ['grace-period', 'grace-ending-soon'],
    defaultSort: 'grace-end',
  },
  {
    id: 'all',
    label: 'All names',
    title: 'All scanned .eth names',
    summary: 'Every name in the snapshot, whatever its state at the scan time.',
    statuses: [],
    defaultSort: 'name',
  },
]

export const DEFAULT_VIEW_ID = DEFAULT_VIEW.id

export function findView(id: string): ViewDefinition | null {
  return VIEWS.find((view) => view.id === id) ?? null
}

export function viewOrDefault(id: string): ViewDefinition {
  return findView(id) ?? DEFAULT_VIEW
}

export const SORT_LABEL: Readonly<Record<SortId, string>> = {
  name: 'Name',
  expiry: 'Expiry',
  'grace-end': 'Grace period ends',
  'premium-end': 'Premium ends',
}

export const SORT_IDS = ['name', 'expiry', 'grace-end', 'premium-end'] as const

const SORT_SET: ReadonlySet<string> = new Set<string>(SORT_IDS)

export function isSortId(value: unknown): value is SortId {
  return typeof value === 'string' && SORT_SET.has(value)
}

export function isSortDirection(value: unknown): value is SortDirection {
  return value === 'asc' || value === 'desc'
}
