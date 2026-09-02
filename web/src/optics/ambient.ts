/**
 * The ambient optical loop.
 *
 * The background is one coherent optical system: a glass object at `(lx, ly)`, the
 * caustic it casts at `(cx, cy)`, and a beam ribbon joining them. Its whole coupling
 * to the rest of the page is seven custom properties on the document element, so the
 * layout and the light know nothing about each other.
 *
 * This module reads nothing about the pointer, the hover target, the focused element,
 * the selected name, or the composer. It is a pure function of elapsed time. There is
 * deliberately no listener here that could feed a coordinate in, and this file imports
 * nothing from `components/` or `state/`, so a coordinate is not merely unused but
 * unavailable: the constraint is structural rather than a rule someone has to remember.
 *
 * Discovery is answered by the name itself - the letterform splits chromatically and an
 * ink rule lands under it - never by moving the light.
 */

/** Below this width the composition is re-based, because the glass would otherwise sit off-screen. */
export const MOBILE_QUERY = '(max-width: 560px)'

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/**
 * Where the system sits at rest, and how far it is allowed to drift.
 *
 * The amplitudes are small on purpose. Both bright ends stay inside the empty
 * top-right corner for the whole cycle, so the caustic's hot centre can never drift
 * onto the type and take the contrast with it.
 */
export interface OpticalBase {
  /** Glass centre. */
  readonly lx: number
  readonly ly: number
  /** Where the caustic lands. */
  readonly cx: number
  readonly cy: number
  /** Glass drift, in pixels either side of the base. */
  readonly ax: number
  readonly ay: number
  /** Caustic drift, in pixels either side of the base. */
  readonly cax: number
  readonly cay: number
}

export const DESKTOP_BASE: OpticalBase = {
  lx: 1272,
  ly: 178,
  cx: 1090,
  cy: 268,
  ax: 26,
  ay: 15,
  cax: 42,
  cay: 24,
}

export const MOBILE_BASE: OpticalBase = {
  lx: 326,
  ly: 150,
  cx: 254,
  cy: 206,
  ax: 13,
  ay: 8,
  cax: 21,
  cay: 13,
}

/** One composed frame. Every value is a number; `writeFrame` adds the units. */
export interface OpticalFrame {
  readonly lx: number
  readonly ly: number
  readonly cx: number
  readonly cy: number
  /** Glass rotation, in degrees. */
  readonly cf: number
  /** Refraction spread, unitless, around 1. */
  readonly sep: number
  /** Beam angle, in degrees. Always derived, never authored. */
  readonly ba: number
}

/** The seven properties the loop owns, in the order they are written. */
export const OPTICAL_PROPERTIES = ['--lx', '--ly', '--cx', '--cy', '--cf', '--sep', '--ba'] as const

/** Glass rotation at rest. The turn is measured from here. */
const REST_TURN_DEGREES = 212

/** One full turn of the glass. */
const TURN_SECONDS = 97

/**
 * Six incommensurate periods, all between 41 and 97 seconds.
 *
 * Nothing repeats on any human timescale and nothing jumps, but the same elapsed time
 * always produces the same frame, so the motion is deterministic rather than random.
 */
const PERIODS = {
  lx: { period: 53, phase: 0 },
  ly: { period: 67, phase: 0.31 },
  cx: { period: 41, phase: 0.17 },
  cy: { period: 59, phase: 0.62 },
  sep: { period: 73, phase: 0.44 },
} as const

/** Refraction breathes between 0.86 and 1, never above it. */
const SEPARATION_SWING = 0.07

function wave(seconds: number, period: number, phase: number): number {
  return Math.sin((seconds / period + phase) * Math.PI * 2)
}

/**
 * The beam angle that joins the glass to its caustic.
 *
 * Deriving this rather than authoring it is what keeps one optical system instead of
 * three unrelated blobs: the ribbon passes through both points by construction, so it
 * cannot fall out of agreement with them.
 */
function beamAngle(lx: number, ly: number, cx: number, cy: number): number {
  return (Math.atan2(cy - ly, cx - lx) * 180) / Math.PI
}

/** The frame for a given elapsed time. Pure, and the only place the motion is defined. */
export function ambientFrame(elapsedMs: number, base: OpticalBase): OpticalFrame {
  const seconds = elapsedMs / 1000
  const lx = base.lx + wave(seconds, PERIODS.lx.period, PERIODS.lx.phase) * base.ax
  const ly = base.ly + wave(seconds, PERIODS.ly.period, PERIODS.ly.phase) * base.ay
  const cx = base.cx + wave(seconds, PERIODS.cx.period, PERIODS.cx.phase) * base.cax
  const cy = base.cy + wave(seconds, PERIODS.cy.period, PERIODS.cy.phase) * base.cay
  return {
    lx,
    ly,
    cx,
    cy,
    cf: (REST_TURN_DEGREES + (seconds / TURN_SECONDS) * 360) % 360,
    sep:
      1 +
      wave(seconds, PERIODS.sep.period, PERIODS.sep.phase) * SEPARATION_SWING -
      SEPARATION_SWING,
    ba: beamAngle(lx, ly, cx, cy),
  }
}

/**
 * The composition reduced motion holds.
 *
 * This is the base points with the glass square-on and the refraction closed, which is
 * a deliberate arrangement rather than wherever `ambientFrame(0)` happens to land: at
 * zero the refraction wave is already part-way through its swing, and a frozen frame
 * showing a half-open effect reads as a stalled animation rather than as a still.
 */
export function staticFrame(base: OpticalBase): OpticalFrame {
  return {
    lx: base.lx,
    ly: base.ly,
    cx: base.cx,
    cy: base.cy,
    cf: REST_TURN_DEGREES,
    sep: 1,
    ba: beamAngle(base.lx, base.ly, base.cx, base.cy),
  }
}

/** Writes one frame to the document element, with the units the stylesheet expects. */
export function writeFrame(root: HTMLElement, frame: OpticalFrame): void {
  root.style.setProperty('--lx', `${frame.lx.toFixed(1)}px`)
  root.style.setProperty('--ly', `${frame.ly.toFixed(1)}px`)
  root.style.setProperty('--cx', `${frame.cx.toFixed(1)}px`)
  root.style.setProperty('--cy', `${frame.cy.toFixed(1)}px`)
  root.style.setProperty('--cf', `${frame.cf.toFixed(1)}deg`)
  root.style.setProperty('--sep', frame.sep.toFixed(3))
  root.style.setProperty('--ba', `${frame.ba.toFixed(2)}deg`)
}

/**
 * The runtime.
 *
 * Module state rather than component state, and one frame in flight at most. Driving
 * this from a React render would tie the six periods to the render cadence, and they
 * would stop being a pure function of elapsed time the first time something else
 * caused a re-render.
 */

let started = 0
let frame = 0
/** Elapsed time already banked from earlier runs, so a pause does not rewind the composition. */
let bankedMs = 0
/** Timestamp the current run began at, or null while no run is in flight. */
let runOriginMs: number | null = null

function reducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches
}

function currentBase(): OpticalBase {
  return window.matchMedia(MOBILE_QUERY).matches ? MOBILE_BASE : DESKTOP_BASE
}

function tick(now: number): void {
  frame = 0
  runOriginMs ??= now
  bankedMs += now - runOriginMs
  runOriginMs = now
  writeFrame(document.documentElement, ambientFrame(bankedMs, currentBase()))
  schedule()
}

/** Being alive at rest is the point, so the loop reschedules itself for as long as it runs. */
function schedule(): void {
  if (started === 0 || frame !== 0 || reducedMotion() || document.hidden) {
    return
  }
  frame = window.requestAnimationFrame(tick)
}

function cancel(): void {
  if (frame !== 0) {
    window.cancelAnimationFrame(frame)
    frame = 0
  }
  // Dropping the origin banks nothing further, so the next run resumes from the
  // elapsed time already banked rather than jumping forward by the length of the gap.
  runOriginMs = null
}

/** Holds the deliberate still, and cancels anything in flight. */
function freeze(): void {
  cancel()
  writeFrame(document.documentElement, staticFrame(currentBase()))
}

function onPreferenceChange(): void {
  if (reducedMotion()) {
    freeze()
  } else {
    schedule()
  }
}

function onVisibilityChange(): void {
  // A hidden tab gets no frames anyway. Banking the elapsed time and standing down
  // means a backgrounded tab costs nothing, and returning to it picks the composition
  // up where it left off instead of somewhere else entirely.
  if (document.hidden) {
    cancel()
  } else {
    schedule()
  }
}

function media(): MediaQueryList[] {
  return [window.matchMedia(REDUCED_MOTION_QUERY), window.matchMedia(MOBILE_QUERY)]
}

/**
 * Starts the loop, or joins one already running.
 *
 * Reference counted because `StrictMode` double-invokes effects in development: the
 * loop has to tolerate being started twice and torn down once, for the same reason the
 * snapshot loader does.
 */
export function startAmbient(): void {
  started += 1
  if (started > 1) {
    return
  }
  for (const query of media()) {
    query.addEventListener('change', onPreferenceChange)
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  if (reducedMotion()) {
    freeze()
  } else {
    // One frame is written straight away rather than waiting for the first callback,
    // so the light is composed on the paint the visitor actually sees first.
    writeFrame(document.documentElement, ambientFrame(bankedMs, currentBase()))
    schedule()
  }
}

/** Releases one hold on the loop, stopping it when the last one goes. */
export function stopAmbient(): void {
  if (started === 0) {
    return
  }
  started -= 1
  if (started > 0) {
    return
  }
  for (const query of media()) {
    query.removeEventListener('change', onPreferenceChange)
  }
  document.removeEventListener('visibilitychange', onVisibilityChange)
  cancel()
}
