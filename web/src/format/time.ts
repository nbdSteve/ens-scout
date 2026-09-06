/**
 * Time formatting shared by the scan-age line, the per-group staleness banner,
 * and the per-row countdown.
 *
 * Every function takes a number of seconds or an instant that came out of the
 * snapshot. None of them decide what a duration means: no grace end is derived
 * from an expiry here, and no status is inferred from a remaining time.
 */

const SECOND = 1
const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * The exact scan time, always in UTC. The snapshot is published in UTC with
 * second precision, and showing it in the visitor's zone would make two people
 * comparing notes disagree about which scan they are looking at.
 */
export function formatAbsolute(date: Date): string {
  const { day, clock } = splitAbsolute(date)
  return `${day} ${clock}`
}

/**
 * The same instant as its two halves, so a caller in a narrow column can keep each
 * half whole and break only between them. Left as one string, the browser is free
 * to break after every `-` and every `:`, and in a phone-width table cell
 * `2026-03-04 12:00:00 UTC` becomes four lines.
 */
export function splitAbsolute(date: Date): { readonly day: string; readonly clock: string } {
  const iso = date.toISOString()
  return { day: iso.slice(0, 10), clock: `${iso.slice(11, 19)} UTC` }
}

/** The same instant as a machine-readable attribute value. */
export function toIsoSecond(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`
}

function plural(count: number, unit: string): string {
  return `${String(count)} ${unit}${count === 1 ? '' : 's'}`
}

/**
 * A duration a person can read at a glance, rounded down to its largest whole
 * unit: `3 days`, `5 hours`, `12 minutes`. Rounding down never overstates how
 * much time is left, which matters when the number next to it is a deadline.
 */
export function formatCoarseDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  if (total < MINUTE) {
    return 'less than a minute'
  }
  if (total < HOUR) {
    return plural(Math.floor(total / MINUTE), 'minute')
  }
  if (total < DAY) {
    const hours = Math.floor(total / HOUR)
    const minutes = Math.floor((total % HOUR) / MINUTE)
    return minutes === 0
      ? plural(hours, 'hour')
      : `${plural(hours, 'hour')} ${plural(minutes, 'minute')}`
  }
  const days = Math.floor(total / DAY)
  const hours = Math.floor((total % DAY) / HOUR)
  return hours === 0 ? plural(days, 'day') : `${plural(days, 'day')} ${plural(hours, 'hour')}`
}

/**
 * The ticking form, fixed-width so a column of them does not jitter as digits
 * change: `12d 03:04:05`, `03:04:05`, `04:05`.
 */
export function formatPreciseDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const days = Math.floor(total / DAY)
  const hours = Math.floor((total % DAY) / HOUR)
  const minutes = Math.floor((total % HOUR) / MINUTE)
  const secs = Math.floor(total % MINUTE)
  const pad = (value: number): string => String(value).padStart(2, '0')
  if (days > 0) {
    return `${String(days)}d ${pad(hours)}:${pad(minutes)}:${pad(secs)}`
  }
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`
  }
  return `${pad(minutes)}:${pad(secs)}`
}

/** How long ago something happened, coarse: `3 hours ago`, `just now`. */
export function formatAgo(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  if (total < MINUTE) {
    return 'just now'
  }
  return `${formatCoarseDuration(total)} ago`
}

/** Whole seconds between two instants, positive when `later` is after `earlier`. */
export function secondsBetween(earlier: Date, later: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / 1000 / SECOND)
}
