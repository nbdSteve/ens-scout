import { SUGGESTIONS_MAX } from './contract'
import type { Shortlist } from './shortlist'
import { shortlistNames } from './shortlist'
import { preferenceDescription, termsOf, type Preference } from './vibes'

/**
 * What the model is asked, and the shape it is allowed to answer in.
 *
 * Pure string and object construction. Nothing here loads a model, reaches a network,
 * or reads anything but the shortlist and the preference it is handed, so a test can
 * assert the exact prompt and the exact schema without a device that has WebGPU.
 *
 * The schema is the first line of the shortlist rule and `parse.ts` is the second. The
 * name field is an `enum` over exactly the shortlist, so a grammar-constrained decoder
 * cannot emit a name that was not offered - and `parse.ts` still checks membership
 * afterwards, because the constraint is the library's promise and the check is this
 * page's. Neither one is redundant: a library that stopped applying the grammar would
 * be caught, and a shortlist the grammar did apply is proven rather than assumed.
 *
 * The prompt asks the model only to rank names. Explanations are derived from the
 * deterministic scoring evidence in `shortlist.ts`, so generated prose has no field in
 * the schema and no path to the UI.
 */

/** The system message. Fixed, so the only thing that varies between calls is the list. */
export const SYSTEM_PROMPT = [
  'You rank short web3 names from a fixed list.',
  'You will be given a list of candidate names and a description of what the person wants.',
  `Choose at most ${String(SUGGESTIONS_MAX)} names from the list, best first.`,
  'You may only choose names that appear in the list, copied exactly as written.',
  'Do not assess availability, registration, expiry, price, or sale status.',
  'Answer with JSON only.',
].join(' ')

/**
 * The JSON schema the decoder is constrained to.
 *
 * `additionalProperties: false` on both levels and `required` on every field, so the
 * only document the grammar admits is the one `parse.ts` accepts. A pick carries only a
 * name, so lifecycle claims, qualified names in prose, and every other generated sentence
 * are structurally outside the accepted document.
 */
export function suggestionSchema(names: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['picks'],
    properties: {
      picks: {
        type: 'array',
        minItems: 1,
        maxItems: SUGGESTIONS_MAX,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string', enum: [...names] },
          },
        },
      },
    },
  }
}

/** One request: what to send, and the exact set an answer may name. */
export interface SuggestPrompt {
  readonly system: string
  readonly user: string
  readonly schema: Record<string, unknown>
  /** The shortlist, in its own order. `parse.ts` checks an answer against this. */
  readonly allowed: readonly string[]
}

/**
 * Builds one request from a shortlist and a preference.
 *
 * The names are listed one per line and numbered, because a bare comma-separated list
 * of `.eth` names reads as prose to a small model and it starts inventing more of them.
 *
 * What the visitor wants is described by `preferenceDescription` and never by
 * `preferenceLabel`. That is the whole reason those are two functions: the label reads a
 * typed theme back as it was typed, punctuation and all, which is right on screen and would
 * put braces, colons, and newlines into this prompt. The description gives a vibe's own
 * fixed label and a theme its terms, so whatever was typed reaches the model as words.
 *
 * The terms line is dropped when the description already is the terms, which is exactly the
 * theme case. Saying the same list twice to a 360M model spends context and teaches it
 * nothing.
 */
export function buildPrompt(shortlist: Shortlist, preference: Preference): SuggestPrompt {
  const allowed = shortlistNames(shortlist)
  const listing = allowed.map((name, index) => `${String(index + 1)}. ${name}`).join('\n')
  const terms = termsOf(preference).join(', ')
  const wanted = preferenceDescription(preference)
  const user = [
    `What the person wants: ${wanted}`,
    ...(wanted === terms ? [] : [`Words that describe it: ${terms}`]),
    '',
    'Candidate names:',
    listing,
    '',
    `Choose at most ${String(SUGGESTIONS_MAX)} of those names.`,
  ].join('\n')
  return { system: SYSTEM_PROMPT, user, schema: suggestionSchema(allowed), allowed }
}
