import type { VerifiedName, VerifiedNames } from './types'

/**
 * The one rule that decides whether a name may be offered an outbound registration
 * link.
 *
 * A published snapshot is a record of one scan, and a scan is minutes to hours old
 * by the time anyone reads it. Sending a visitor to register a name on that basis
 * would be the page making a claim only the registry can make, so a link out is
 * offered for exactly one reason: a fresh check succeeded for that name and has not
 * expired. Nothing else opens the gate - not an `available` status, not a recent
 * scan, not a countdown that has run down.
 *
 * This is deliberately the only place that decision is made. Anything that suggests
 * a name and then offers a way to act on it has to come through here, including the
 * generation seam `docs/website-plan.md` describes and this PR does not implement: a
 * suggested name is even less verified than a scanned one, so a second gate for it
 * would be a second answer to a question with one right answer. There is no
 * parameter for the caller and no way to pass one, which is the enforcement.
 *
 * Expiry is judged against the instant the caller is rendering at, which on this
 * page is `useNow` - so a `?now=` clock moves this too, and a demonstration of an
 * expired check is a demonstration of the real rule rather than of a special case.
 */

export type OutboundVerdict =
  /** A fresh check covers this name and is still current. */
  | { readonly allowed: true; readonly verified: VerifiedName }
  /**
   * No check has covered this name in this session. The distinction from 'expired'
   * is what the page says: one asks for a check, the other says the check has lapsed.
   */
  | { readonly allowed: false; readonly reason: 'unverified' }
  /** A check covered this name and its answer is no longer current. */
  | { readonly allowed: false; readonly reason: 'expired'; readonly verified: VerifiedName }

const UNVERIFIED: OutboundVerdict = { allowed: false, reason: 'unverified' }

/**
 * Resolves one name's outbound verdict.
 *
 * `expiresAt` is the endpoint's own instant, not one derived here, and the comparison
 * is exclusive at it: an answer is current up to the moment it says it stops being
 * one, and at that moment it has stopped.
 */
export function resolveOutbound(name: string, verified: VerifiedNames, now: Date): OutboundVerdict {
  const entry = verified.get(name)
  if (entry === undefined) {
    return UNVERIFIED
  }
  if (now.getTime() >= entry.expiresAt.getTime()) {
    return { allowed: false, reason: 'expired', verified: entry }
  }
  return { allowed: true, verified: entry }
}

/** Whether a name may be linked out to. The predicate form, for a caller that needs no detail. */
export function mayLinkOut(name: string, verified: VerifiedNames, now: Date): boolean {
  return resolveOutbound(name, verified, now).allowed
}
