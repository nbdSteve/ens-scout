import { describe, expect, it } from 'vitest'
import { capture, goSource } from '../test/goSource'
import {
  CADENCE_INTERVAL_SECONDS,
  CADENCES,
  FORMAT_VERSION,
  NAME_SUFFIX,
  STALE_FACTOR,
  STATUSES,
} from './contract'

/**
 * The guard on `contract.ts`.
 *
 * Go owns every value restated there, and the browser cannot derive them from
 * the payload it is handed: per-group staleness needs the interval of each
 * cadence, and the wire carries only the slowest one. `src/test/goSource.ts`
 * says why this reads the Go sources and why a parse that finds nothing fails.
 */

const snapshotGo = goSource('internal/snapshot/snapshot.go')
const modelGo = goSource('internal/ens/model.go')

describe('the constants the browser restates', () => {
  it('accepts the format version Go writes', () => {
    expect(Number(capture(snapshotGo, 'FormatVersion', /^const FormatVersion = (\d+)$/m))).toBe(
      FORMAT_VERSION,
    )
  })

  it('strips the parent zone Go stores', () => {
    expect(capture(snapshotGo, 'NameSuffix', /^const NameSuffix = "([^"]+)"$/m)).toBe(NAME_SUFFIX)
  })

  it('tolerates the same number of missed scans', () => {
    expect(Number(capture(snapshotGo, 'StaleFactor', /^const StaleFactor = (\d+)$/m))).toBe(
      STALE_FACTOR,
    )
  })
})

describe('the ordered sets the browser restates', () => {
  it('lists every lifecycle status, in Go order', () => {
    // `ens.Statuses`, resolved through the constants it names. Order matters:
    // the summary counts and the status filter are both rendered in it.
    const names = capture(modelGo, 'ens.Statuses', /var Statuses = \[\]Status\{([^}]+)\}/)
      .split(',')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('//'))

    const values = names.map((name) => {
      const declared = new RegExp(`\\b${name}\\s+Status\\s*=\\s*"([^"]+)"`)
      return capture(modelGo, name, declared)
    })

    expect(values).toEqual([...STATUSES])
  })

  it('lists every cadence, in Go order', () => {
    const names = capture(snapshotGo, 'snapshot.Cadences', /var Cadences = \[\]Cadence\{([^}]+)\}/)
      .split(',')
      .map((line) => line.trim())
      .filter((line) => line !== '')

    const values = names.map((name) =>
      capture(snapshotGo, name, new RegExp(`\\b${name}\\s+Cadence\\s*=\\s*"([^"]+)"`)),
    )

    expect(values).toEqual([...CADENCES])
  })

  it('measures each cadence against the interval Go schedules it on', () => {
    /*
     * `Cadence.Interval` is a switch, so the arms are read as pairs: the case
     * names a cadence constant and the return gives its duration. Reading the
     * switch rather than a table is what makes a new cadence with no interval
     * here a failure instead of a silent default.
     */
    const body = capture(
      snapshotGo,
      'Cadence.Interval',
      /func \(c Cadence\) Interval\(\) \(time\.Duration, bool\) \{([\s\S]*?)\n\}/,
    )
    const arms = [
      ...body.matchAll(/case (\w+):\s*\n\s*return (\d+) \* time\.(Hour|Minute|Second), true/g),
    ]
    expect(arms.length).toBe(CADENCES.length)

    const unit = { Hour: 3600, Minute: 60, Second: 1 }
    const seconds: Record<string, number> = {}
    for (const [, name, count, named] of arms) {
      const cadence = capture(
        snapshotGo,
        String(name),
        new RegExp(`\\b${String(name)}\\s+Cadence\\s*=\\s*"([^"]+)"`),
      )
      seconds[cadence] = Number(count) * unit[named as keyof typeof unit]
    }

    expect(seconds).toEqual(CADENCE_INTERVAL_SECONDS)
  })
})
