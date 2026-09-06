import type { FailureKind } from '../state/useSnapshot'

/**
 * What the page can offer a visitor whose load failed.
 *
 * The page offers a recovery in two places: the error page, when there is nothing to
 * show, and the stored-copy band, when an earlier scan is on screen instead. The choice
 * is the same in both, so it is made once. It was not, and the button that could not
 * succeed shipped in the second of them.
 */

/**
 * Whether only a document load can clear a failure.
 *
 * A version mismatch is the one kind another request cannot fix: the payload is newer
 * than this bundle, so fetching it again from the same bundle lands on the same refusal.
 * The other two are worth asking again for - an unreachable API may come back, and a
 * payload this build refused may be republished.
 */
export function needsNewBundle(kind: FailureKind): boolean {
  return kind === 'version'
}

/** A real document load, which is the only thing that can pick up a newer bundle. */
export function reloadDocument(): void {
  window.location.reload()
}
