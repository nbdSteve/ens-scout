import { describe, expect, it } from 'vitest'
import { CADENCE_INTERVAL_SECONDS, STALE_FACTOR } from './contract'
import {
  cadenceScanAge,
  hasStaleGroup,
  resolveScanAge,
  resolveSnapshotAge,
  resolveSourceGroups,
} from './staleness'
import { SCANNED_AT, buildSnapshot } from '../test/factory'

/**
 * Staleness is the one thing this page decides for itself, so the boundaries are
 * pinned here: a snapshot exactly at its threshold is still trusted, and a
 * three-hourly list is called out while a daily list in the same snapshot is not.
 */

const THREE_HOURLY = CADENCE_INTERVAL_SECONDS['three-hourly']
const DAILY = CADENCE_INTERVAL_SECONDS.daily

function at(offsetSeconds: number): Date {
  return new Date(SCANNED_AT.getTime() + offsetSeconds * 1000)
}

describe('resolveScanAge', () => {
  it('reports the age in whole seconds', () => {
    const age = resolveScanAge(SCANNED_AT, at(3661), DAILY, DAILY * STALE_FACTOR)
    expect(age.ageSeconds).toBe(3661)
    expect(age.isStale).toBe(false)
    expect(age.overdueSeconds).toBe(0)
  })

  it('is still fresh exactly at the threshold', () => {
    const age = resolveScanAge(SCANNED_AT, at(DAILY * STALE_FACTOR), DAILY, DAILY * STALE_FACTOR)
    expect(age.isStale).toBe(false)
    expect(age.overdueSeconds).toBe(0)
  })

  it('is stale one second past the threshold, and says by how much', () => {
    const age = resolveScanAge(
      SCANNED_AT,
      at(DAILY * STALE_FACTOR + 1),
      DAILY,
      DAILY * STALE_FACTOR,
    )
    expect(age.isStale).toBe(true)
    expect(age.overdueSeconds).toBe(1)
  })

  it('clamps a reader clock that is behind the scan, and records that it was', () => {
    const age = resolveScanAge(SCANNED_AT, at(-7200), DAILY, DAILY * STALE_FACTOR)
    expect(age.ageSeconds).toBe(0)
    expect(age.clockBehind).toBe(true)
    expect(age.isStale).toBe(false)
  })
})

describe('cadenceScanAge', () => {
  it('derives the stale threshold from the cadence and the shared factor', () => {
    const age = cadenceScanAge('three-hourly', SCANNED_AT, at(0))
    expect(age.expectedIntervalSeconds).toBe(THREE_HOURLY)
    expect(age.staleAfterSeconds).toBe(THREE_HOURLY * STALE_FACTOR)
  })

  it('calls a three-hourly list overdue long before a daily one', () => {
    const now = at(THREE_HOURLY * STALE_FACTOR + 60)
    expect(cadenceScanAge('three-hourly', SCANNED_AT, now).isStale).toBe(true)
    expect(cadenceScanAge('daily', SCANNED_AT, now).isStale).toBe(false)
  })
})

describe('resolveSourceGroups', () => {
  it('resolves each list against its own cadence, not the published aggregate', () => {
    const { metadata } = buildSnapshot()
    const now = at(THREE_HOURLY * STALE_FACTOR + 60)
    const groups = resolveSourceGroups(metadata, now)

    expect(groups.map((group) => group.source.id)).toEqual(['five-letters', 'four-letters'])
    expect(groups.map((group) => group.cadenceLabel)).toEqual(['every 24 hours', 'every 3 hours'])
    expect(groups.map((group) => group.scanAge.isStale)).toEqual([false, true])
  })

  it('flags a stale group even while the whole snapshot still reads fresh', () => {
    const { metadata } = buildSnapshot()
    const now = at(THREE_HOURLY * STALE_FACTOR + 60)

    // The wire thresholds come from the slowest cadence, so the aggregate is fine.
    expect(resolveSnapshotAge(metadata, now).isStale).toBe(false)
    expect(hasStaleGroup(resolveSourceGroups(metadata, now))).toBe(true)
  })

  it('reports nothing stale inside every window', () => {
    const { metadata } = buildSnapshot()
    const groups = resolveSourceGroups(metadata, at(60))
    expect(hasStaleGroup(groups)).toBe(false)
  })
})
