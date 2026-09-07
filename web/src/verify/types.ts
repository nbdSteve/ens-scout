import type { ResultDocument, SnapshotResult } from '../snapshot/types'

/**
 * The check wire shape, exactly as `internal/api` serializes it, and the view the
 * page holds it as.
 */

export interface CheckDocument {
  readonly format_version: number
  readonly source: string
  readonly authority: string
  /** When the index was really read. Everything below is true as of this instant. */
  readonly checked_at: string
  /** When this answer stops being a fresh check. The page refuses it from then on. */
  readonly expires_at: string
  /** The exact normalized names this answer covers. */
  readonly names: readonly string[]
  readonly results: readonly ResultDocument[]
  readonly advisory: string
}

/**
 * One checked name.
 *
 * It is `SnapshotResult` deliberately, not a second shape: both are `ens.Result` on
 * the wire, and one classifier in `internal/ens` produced both. The difference
 * between a recorded status and a freshly read one is when it was established, not
 * what it is, so it belongs to how the page presents a result rather than to the
 * result's type. A second type here would invite a second classifier next.
 */
export type CheckedResult = SnapshotResult

/** One whole verified answer, as the page holds it. */
export interface Verification {
  readonly checkedAt: Date
  readonly expiresAt: Date
  /** The names asked about, in the order the endpoint returned them. */
  readonly names: readonly string[]
  readonly results: readonly CheckedResult[]
}

/**
 * One name's verification, kept per name rather than per check.
 *
 * A visitor checks two names, then checks a third. Holding one whole-verification
 * value would have dropped the first two the moment the third answered, and taken
 * their outbound links with it. Each name therefore carries the instant it was
 * really checked and its own expiry, and each expires on its own.
 */
export interface VerifiedName {
  readonly result: CheckedResult
  readonly checkedAt: Date
  readonly expiresAt: Date
}

/** Every name verified so far, keyed by the fully-qualified name. */
export type VerifiedNames = ReadonlyMap<string, VerifiedName>
