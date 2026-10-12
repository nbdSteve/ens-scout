import { describe, expect, it } from 'vitest'
import { DEFAULT_QUERY, type QueryState } from '../state/query'
import { isCanonicalFeaturedRoute } from './route'

function query(change: Partial<QueryState> = {}): QueryState {
  return { ...DEFAULT_QUERY, ...change }
}

describe('isCanonicalFeaturedRoute', () => {
  it('admits only the unfiltered default Available route', () => {
    expect(isCanonicalFeaturedRoute(DEFAULT_QUERY)).toBe(true)
  })

  it.each([
    ['view', query({ view: 'all' })],
    ['search', query({ search: 'vex' })],
    ['status', query({ statuses: ['available'] })],
    ['minimum length', query({ length: { min: 3, max: null } })],
    ['maximum length', query({ length: { min: null, max: 5 } })],
    ['source list', query({ list: 'three-letters' })],
    ['sort', query({ sort: 'expiry' })],
    ['direction', query({ direction: 'desc' })],
    ['page', query({ page: 2 })],
    ['preview clock', query({ now: new Date('2026-03-01T12:00:00Z') })],
  ])('bypasses the hero for a %s deep link', (_field, state) => {
    expect(isCanonicalFeaturedRoute(state)).toBe(false)
  })
})
