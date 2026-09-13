import type { ReactNode } from 'react'
import { MODEL_DOWNLOAD_BYTES, MODEL_VRAM_MB } from '../suggest/contract'
import type { SuggestFailureStage } from '../suggest/failure'
import type { SuggestPhase, SuggestStore } from '../state/useSuggest'
import { Notice } from './Notice'

/**
 * What the optional model is doing, and how to stop it.
 *
 * Every state this block can be in is a sentence and, where there is a decision to make,
 * a button. None of them is an error page: the names are ranked either way, so the worst
 * thing that can happen here is that the order comes from this page instead of the model,
 * and that is said plainly rather than apologised for.
 *
 * The size is stated before anything is fetched. That is the whole reason
 * `START_GRACE_MS` exists: a download this large must be refusable by somebody who has
 * only just been told about it, so the figure and both controls are on screen with
 * nothing yet in flight.
 *
 * Pausing and turning off are two different promises and are labelled as two. Pausing is
 * for this page - it stops what is happening now and nothing is remembered. Turning off
 * is remembered on this device, so a visitor who does not want this is not asked again on
 * their next visit.
 *
 * The library's own progress text is deliberately not shown. It is written for a console:
 * it quotes asset paths and cache internals, and the host those paths are on is the one
 * thing this page otherwise never names. The fraction is a number, so it is safe, and a
 * percentage is what a visitor wanted from that line anyway.
 */
export interface SuggestModelStateProps {
  readonly store: SuggestStore
}

/*
 * The two figures, in decimal megabytes.
 *
 * Decimal rather than binary because a browser's own download indicator counts that way,
 * and a figure a visitor can check against the one their browser shows them is worth more
 * than a more precise one they cannot. Rounded to whole megabytes: the exact byte count is
 * in `suggest/contract.ts` and `web/README.md` records how it was measured, and neither of
 * those belongs in a sentence.
 */
const DOWNLOAD_SIZE = `${Math.round(MODEL_DOWNLOAD_BYTES / 1_000_000).toLocaleString('en-GB')} MB`
const MEMORY_SIZE = `${Math.round(MODEL_VRAM_MB).toLocaleString('en-GB')} MB`

/**
 * One line per phase.
 *
 * A total map rather than a switch with a default, so a phase added to `SuggestPhase` is
 * a type error here instead of quietly becoming the vaguest sentence. 'unavailable' is
 * short because the failure banner below it carries the reason; every other state has no
 * banner and has to say everything itself.
 */
const LINE_BY_PHASE: Readonly<Record<SuggestPhase, string>> = {
  waiting:
    'An optional model can run inside this browser to rank the shortlist. Nothing has been downloaded yet.',
  checking: 'Checking whether this device can run the optional model.',
  loading: 'Downloading the optional model.',
  ready: 'The optional model is ready in this browser.',
  generating: 'The model is ranking suggestions.',
  paused: 'The optional model is not in use. The names below are ranked by this page instead.',
  cancelled: 'The download was stopped. The names below are ranked by this page instead.',
  disabled:
    'The optional model is turned off on this device. The names below are ranked by this page instead.',
  unavailable: 'The optional model is not in use on this device.',
}

const FAILURE_TITLE_BY_STAGE: Readonly<Record<SuggestFailureStage, string>> = {
  support: 'The model is unavailable here',
  loading: 'The model could not be loaded',
  generation: 'The model did not answer',
}

/** Whether this phase is one where something is, or is about to be, fetched. */
function beforeOrDuringLoad(phase: SuggestPhase): boolean {
  return phase === 'waiting' || phase === 'checking' || phase === 'loading'
}

/**
 * What stopping means from here, in the visitor's terms.
 *
 * One control, because there is one thing it does - release whatever is happening and
 * stop for this page - but four honest ways to describe that depending on what is
 * happening. A button labelled 'Stop the download' while nothing is downloading would be
 * describing the implementation rather than the choice.
 */
function pauseLabel(phase: SuggestPhase): string {
  if (phase === 'waiting') {
    return 'Do not download it'
  }
  if (phase === 'checking' || phase === 'loading') {
    return 'Stop the download'
  }
  return 'Stop using it'
}

export function SuggestModelState({ store }: SuggestModelStateProps): ReactNode {
  const { phase, progress, slow, failure, cached, capabilities } = store
  const fraction = progress?.fraction ?? null
  const percent = fraction === null ? null : Math.round(fraction * 100)

  return (
    <div className="suggest__model">
      {/*
        A polite region that is mounted with the panel and holds one short line. It
        changes on a phase change and nothing else, so it announces the four transitions
        a visitor cares about - checking, downloading, ready, stopped - and does not
        chatter while a download runs.
      */}
      <p className="suggest__state" role="status">
        {LINE_BY_PHASE[phase]}
      </p>

      {beforeOrDuringLoad(phase) &&
        (cached ? (
          <p className="suggest__size">
            It is already stored in this browser, so there is nothing to download. It needs about{' '}
            {MEMORY_SIZE} of graphics memory while it runs.
          </p>
        ) : (
          <p className="suggest__size">
            The first load transfers {DOWNLOAD_SIZE} and it needs about {MEMORY_SIZE} of graphics
            memory to run. It is stored in this browser afterwards, so it is downloaded once. It is
            never needed to see the names.
          </p>
        ))}

      {progress !== null && (
        <p className="suggest__progress-row">
          {/*
            A native progress element, so the value is exposed without this page
            reimplementing a role. Indeterminate while the fraction is unknown, which is
            honest: a bar sitting at zero would read as stalled.
          */}
          <progress
            aria-label="Model download"
            className="suggest__progress"
            max={100}
            value={percent ?? undefined}
          />
          <span className="suggest__progress-figure">
            {percent === null ? 'Working' : `${String(percent)}%`}
          </span>
        </p>
      )}

      {slow && beforeOrDuringLoad(phase) && (
        <p className="suggest__slow">
          This is taking a while. You can stop it and keep the names below, which are already
          ranked.
        </p>
      )}

      <p className="suggest__controls">
        {capabilities.pause && (
          <button className="button button--quiet" onClick={store.pause} type="button">
            {pauseLabel(phase)}
          </button>
        )}
        {capabilities.resume && (
          <button className="button button--quiet" onClick={store.resume} type="button">
            {phase === 'paused' ? 'Use the model' : 'Try again'}
          </button>
        )}
        {capabilities.enable && (
          <button className="button button--quiet" onClick={store.enable} type="button">
            Turn it back on
          </button>
        )}
        {capabilities.disable && (
          <button className="button button--quiet" onClick={store.disable} type="button">
            Turn it off on this device
          </button>
        )}
      </p>

      {/*
        The failure, wherever it happened. It is shown even while the phase is 'ready',
        because a refused answer leaves the model loaded and perfectly usable: what failed
        was one generation, and the sentence says so. `role="alert"` governs its own
        subtree, so it is announced from here without the status line above repeating it.
      */}
      {failure !== null && (
        <Notice tone="warn" voice="alert" title={FAILURE_TITLE_BY_STAGE[failure.stage]}>
          <p>{failure.message}</p>
        </Notice>
      )}
    </div>
  )
}
