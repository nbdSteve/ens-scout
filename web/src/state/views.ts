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
 */

export type SortId = 'name' | 'expiry' | 'grace-end' | 'premium-end'

export type SortDirection = 'asc' | 'desc'

export interface ViewDefinition {
  readonly id: string
  readonly label: string
  /** What the view is for, shown under the heading and as the tab's description. */
  readonly summary: string
  /** Statuses the view admits. An empty list admits every status. */
  readonly statuses: readonly Status[]
  readonly defaultSort: SortId
}

/**
 * The view a visitor gets with no view named, and the fallback for a link that
 * names one this build does not have. It is a named constant so the fallback
 * needs no cast: there is no way for the default view to be missing.
 */
export const DEFAULT_VIEW: ViewDefinition = {
  id: 'all',
  label: 'All names',
  summary: 'Every name in the snapshot, whatever its state at the scan time.',
  statuses: [],
  defaultSort: 'name',
}

export const VIEWS: readonly ViewDefinition[] = [
  DEFAULT_VIEW,
  {
    id: 'available',
    label: 'Available',
    summary: 'Released with no temporary premium at the scan time.',
    statuses: ['available'],
    defaultSort: 'name',
  },
  {
    id: 'premium',
    label: 'Premium',
    summary: 'Open to anyone, with a temporary premium still on the price. Soonest to clear first.',
    statuses: ['premium'],
    defaultSort: 'premium-end',
  },
  {
    id: 'expiring',
    label: 'Expiring',
    summary: 'Still registered, but close to expiry at the scan time. Soonest to expire first.',
    statuses: ['expiring-soon'],
    defaultSort: 'expiry',
  },
  {
    id: 'grace',
    label: 'Grace period',
    summary:
      'Expired and owner-only until the grace period ends. Soonest to leave the grace period first.',
    statuses: ['grace-period', 'grace-ending-soon'],
    defaultSort: 'grace-end',
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
