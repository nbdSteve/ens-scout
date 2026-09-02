import { useMemo, useState } from 'react'
import type { CSSProperties, PointerEvent, ReactNode } from 'react'
import { STATUSES } from '../snapshot/contract'
import { codePointLength } from '../format/text'
import { formatAbsolute, toIsoSecond } from '../format/time'
import { ensAppUrl } from '../snapshot/lifecycle'
import type { Snapshot } from '../snapshot/types'
import { prototypeSnapshot } from './data'

/**
 * A visual prototype of the name-exploration surface. Not the site.
 *
 * The shipped app is untouched and still lives on `/`. This route exists to settle
 * one question before any of it is integrated: what the page should look and feel
 * like. So it is deliberately thin - one view, no URL state, no read API, no
 * caching - and it carries almost no words. The visible vocabulary is the wordmark,
 * `Available`, the count, three control labels, the snapshot chip, `Verify on ENS`,
 * `Data`, and the names themselves. Anything a reader would call a sentence belongs
 * inside `Data`, which is closed until asked for.
 *
 * It still never classifies. Every status here was written down by the scanner and
 * validated by the shipped parser, and the only thing computed in the browser is
 * how long ago the scan was - against this device's clock, which is why the chip
 * says so where a screen reader can hear it.
 */

/** Milliseconds, for the terse age. */
const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * The age, as few characters as it can honestly be: `1h`, `3d`, `20m`.
 *
 * Coarse on purpose. The chip is a glance, not a measurement, and the exact scan
 * instant is one line down in `Data` for anyone comparing two scans.
 */
function terseAge(seconds: number): string {
  if (seconds < MINUTE) {
    return 'now'
  }
  if (seconds < HOUR) {
    return `${String(Math.floor(seconds / MINUTE))}m`
  }
  if (seconds < DAY) {
    return `${String(Math.floor(seconds / HOUR))}h`
  }
  return `${String(Math.floor(seconds / DAY))}d`
}

/** The clock, from `?now=` when it parses, and the real one otherwise. */
function readClock(): { readonly now: Date; readonly simulated: boolean } {
  const raw = new URLSearchParams(window.location.search).get('now')
  if (raw !== null) {
    const parsed = new Date(raw)
    if (!Number.isNaN(parsed.getTime())) {
      return { now: parsed, simulated: true }
    }
  }
  return { now: new Date(), simulated: false }
}

export function Prototype(): ReactNode {
  // Built once. The dataset is a literal, so re-deriving it on every keystroke
  // would only re-run the parser over the same bytes.
  const snapshot: Snapshot = useMemo(() => prototypeSnapshot(), [])
  const [clock] = useState(readClock)
  const [query, setQuery] = useState('')
  const [min, setMin] = useState('')
  const [max, setMax] = useState('')
  const [still] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)

  const available = useMemo(
    () => snapshot.results.filter((result) => result.status === 'available'),
    [snapshot],
  )

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const low = Number.parseInt(min, 10)
    const high = Number.parseInt(max, 10)
    return available.filter((result) => {
      if (needle !== '' && !result.label.includes(needle)) {
        return false
      }
      const length = codePointLength(result.label)
      if (!Number.isNaN(low) && length < low) {
        return false
      }
      if (!Number.isNaN(high) && length > high) {
        return false
      }
      return true
    })
  }, [available, query, min, max])

  const ageSeconds = Math.max(
    0,
    Math.floor((clock.now.getTime() - snapshot.metadata.scannedAt.getTime()) / 1000),
  )

  /*
   * The luminous edge follows the pointer, which is the whole of the tile's
   * motion. Written straight onto the element the event is already on: there is
   * no React state per pointer move, and nothing to keep in sync.
   */
  function track(event: PointerEvent<HTMLAnchorElement>): void {
    if (still) {
      return
    }
    const tile = event.currentTarget
    const box = tile.getBoundingClientRect()
    tile.style.setProperty('--mx', `${String(Math.round(event.clientX - box.left))}px`)
    tile.style.setProperty('--my', `${String(Math.round(event.clientY - box.top))}px`)
  }

  return (
    <div className="proto">
      <div aria-hidden="true" className="proto__aurora" />

      <header className="proto__bar">
        <p className="proto__mark">Scout</p>
        <p className="proto__chip">
          <span aria-hidden="true">Snapshot {terseAge(ageSeconds)}</span>
          {/*
            The chip is two words wide, and the instant behind it still has to be
            available rather than implied. This is the announcement: the scan time
            in full, and, when the clock is simulated, that it is.
          */}
          <span className="visually-hidden">
            Snapshot taken{' '}
            <time dateTime={toIsoSecond(snapshot.metadata.scannedAt)}>
              {formatAbsolute(snapshot.metadata.scannedAt)}
            </time>
            , {terseAge(ageSeconds)} before {clock.simulated ? 'a simulated time of ' : 'now, '}
            <time dateTime={toIsoSecond(clock.now)}>{formatAbsolute(clock.now)}</time>
          </span>
        </p>
        <a
          className="proto__verify"
          href="https://app.ens.domains/"
          rel="noopener noreferrer"
          target="_blank"
        >
          Verify on ENS
        </a>
      </header>

      <main className="proto__main">
        <h1 className="proto__hero">
          <span className="proto__heroWord">Available</span>
          <span className="proto__heroCount">{shown.length.toLocaleString('en-GB')}</span>
        </h1>

        <div className="proto__controls">
          <p className="proto__field proto__field--wide">
            <label className="proto__label" htmlFor="proto-search">
              Search
            </label>
            <input
              className="proto__input"
              id="proto-search"
              onChange={(event) => {
                setQuery(event.target.value)
              }}
              type="search"
              value={query}
            />
          </p>
          <p className="proto__field">
            <label className="proto__label" htmlFor="proto-min">
              Min
            </label>
            <input
              className="proto__input proto__input--num"
              id="proto-min"
              inputMode="numeric"
              max={64}
              min={1}
              onChange={(event) => {
                setMin(event.target.value)
              }}
              type="number"
              value={min}
            />
          </p>
          <p className="proto__field">
            <label className="proto__label" htmlFor="proto-max">
              Max
            </label>
            <input
              className="proto__input proto__input--num"
              id="proto-max"
              inputMode="numeric"
              max={64}
              min={1}
              onChange={(event) => {
                setMax(event.target.value)
              }}
              type="number"
              value={max}
            />
          </p>
        </div>

        {/*
          A field of names rather than a grid of cards. Nothing is boxed: the type
          sits directly on the lit field, and the only chrome a name has is its own
          weight. Size carries the label length, so the shape of the page says what
          the two length controls filter on without a word being spent on it.
        */}
        <ul className="proto__names">
          {shown.map((result) => (
            <li className="proto__item" key={result.name}>
              <a
                className="proto__tile"
                href={ensAppUrl(result.name)}
                onPointerMove={track}
                rel="noopener noreferrer"
                style={{ '--len': codePointLength(result.label) } as CSSProperties}
                target="_blank"
              >
                <span className="proto__name">{result.label}</span>
                <span aria-hidden="true" className="proto__zone">
                  .eth
                </span>
              </a>
            </li>
          ))}
        </ul>

        <details className="proto__data">
          <summary className="proto__dataSummary">Data</summary>
          <div className="proto__dataBody">
            <dl className="proto__facts">
              <dt>snapshot</dt>
              <dd>{snapshot.metadata.snapshotId}</dd>
              <dt>scanned</dt>
              <dd>
                <time dateTime={toIsoSecond(snapshot.metadata.scannedAt)}>
                  {formatAbsolute(snapshot.metadata.scannedAt)}
                </time>
              </dd>
              <dt>read at</dt>
              <dd>
                <time dateTime={toIsoSecond(clock.now)}>{formatAbsolute(clock.now)}</time>
                {clock.simulated ? ' (simulated)' : ''}
              </dd>
              <dt>names</dt>
              <dd>{snapshot.metadata.names.toLocaleString('en-GB')}</dd>
            </dl>

            <dl className="proto__facts">
              {snapshot.metadata.sources.map((source) => (
                <div className="proto__factRow" key={source.id}>
                  <dt>{source.path}</dt>
                  <dd>
                    {source.names.toLocaleString('en-GB')} names, {source.cadence}
                  </dd>
                </div>
              ))}
            </dl>

            <dl className="proto__facts">
              {STATUSES.filter((status) => snapshot.metadata.counts[status] > 0).map((status) => (
                <div className="proto__factRow" key={status}>
                  <dt>{status}</dt>
                  <dd>{snapshot.metadata.counts[status].toLocaleString('en-GB')}</dd>
                </div>
              ))}
            </dl>

            <p className="proto__note">
              A record of one scan, not a live check. The scanner classified every name at the
              instant above, and this page only reads what it wrote. Confirm availability and price
              with ENS before registering.
            </p>
          </div>
        </details>
      </main>
    </div>
  )
}
