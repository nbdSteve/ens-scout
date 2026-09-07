import { describe, expect, it } from 'vitest'
import { CheckError } from './check'
import { CHECK_CODES } from './contract'
import { checkNeedsNewBundle, describeCheckFailure } from './failure'
import { CheckFormatError, CheckVersionError } from './parse'

describe('describeCheckFailure', () => {
  it('words every code the endpoint can answer with', () => {
    for (const code of CHECK_CODES) {
      const failure = describeCheckFailure(new CheckError('x', 503, code))
      expect(failure.message).not.toBe('')
      // Nothing derived from a response may reach a screen, so no wording may repeat
      // the code itself either: a code is endpoint vocabulary, not a sentence.
      expect(failure.message).not.toContain(code)
    }
  })

  it.each([
    ['client_throttled', 'throttled', true],
    ['upstream_busy', 'busy', true],
    ['upstream_budget_exhausted', 'busy', true],
    ['check_timed_out', 'timeout', true],
    ['upstream_unavailable', 'upstream', true],
    ['too_many_names', 'selection', false],
    ['malformed_request', 'refused', false],
    ['invalid_name', 'refused', false],
    ['not_found', 'unsupported', false],
    ['method_not_allowed', 'unsupported', false],
    ['client_unidentified', 'unavailable', true],
    /*
     * A store the endpoint could not charge is a site outage rather than a busy site,
     * so it is worded as one and still offers the retry: the usual cause is a
     * throttled table, which the next request may well get past.
     */
    ['check_store_unavailable', 'unavailable', true],
  ] as const)('maps %s to %s', (code, kind, retryable) => {
    const failure = describeCheckFailure(new CheckError('x', 503, code))
    expect(failure.kind).toBe(kind)
    expect(failure.retryable).toBe(retryable)
  })

  /*
   * The code wins over the status on purpose. Several distinct refusals share a 503,
   * and the code is the only thing that tells them apart.
   */
  it('trusts the code over the status', () => {
    expect(describeCheckFailure(new CheckError('x', 503, 'check_timed_out')).kind).toBe('timeout')
    expect(describeCheckFailure(new CheckError('x', 200, 'not_found')).kind).toBe('unsupported')
  })

  it.each([
    [404, 'unsupported'],
    [405, 'unsupported'],
    [413, 'selection'],
    [429, 'throttled'],
    [504, 'timeout'],
    [500, 'unavailable'],
    [418, 'unavailable'],
  ] as const)('falls back to the status for %i', (status, kind) => {
    expect(describeCheckFailure(new CheckError('x', status)).kind).toBe(kind)
  })

  it('reports no response at all as unavailable and retryable', () => {
    const failure = describeCheckFailure(new CheckError('x', null))
    expect(failure.kind).toBe('unavailable')
    expect(failure.retryable).toBe(true)
  })

  it('reports a refused answer as malformed', () => {
    expect(describeCheckFailure(new CheckFormatError('bad')).kind).toBe('malformed')
  })

  /*
   * Checked before the class it extends. A version mismatch worded as a malformed
   * answer would offer a retry that lands on the same refusal.
   */
  it('reports a newer format as its own kind', () => {
    const failure = describeCheckFailure(new CheckVersionError(9))
    expect(failure.kind).toBe('version')
    expect(failure.retryable).toBe(false)
    expect(checkNeedsNewBundle(failure.kind)).toBe(true)
  })

  it('reports anything unrecognised as unavailable', () => {
    for (const cause of [new Error('boom'), 'a string', null, undefined]) {
      expect(describeCheckFailure(cause).kind).toBe('unavailable')
    }
  })

  it('states no version but the version kind needs a new bundle', () => {
    for (const kind of [
      'throttled',
      'busy',
      'timeout',
      'upstream',
      'selection',
      'refused',
      'unsupported',
      'malformed',
      'unavailable',
    ] as const) {
      expect(checkNeedsNewBundle(kind)).toBe(false)
    }
  })

  /*
   * A rendered countdown was deliberately not built. `Retry-After` is on the response,
   * and a sentence naming a number of seconds is wrong the moment a visitor looks away,
   * so nothing here quotes one.
   */
  it('never puts a duration in a sentence', () => {
    for (const code of CHECK_CODES) {
      expect(describeCheckFailure(new CheckError('x', 503, code)).message).not.toMatch(/\d/)
    }
  })
})
