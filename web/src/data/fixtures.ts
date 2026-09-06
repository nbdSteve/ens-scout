/**
 * The committed fixture snapshots, loaded as modules.
 *
 * These are the same files `go test ./internal/snapshot -update` regenerates, so
 * a clean clone gets a working site with no API, no AWS account, and no network:
 * `npm install && npm run dev` renders real published bytes that the Go tests
 * also assert against. Pointing the fixtures at a copy inside `web/` would let
 * the two drift, so they are imported straight from `data/fixtures/`.
 *
 * Each loader is a dynamic import so that a build configured with an API base
 * URL keeps the fixtures out of the entry chunk: they are only fetched if
 * something asks for them.
 */

export const FIXTURE_IDS = ['preview', 'stale'] as const

export type FixtureId = (typeof FIXTURE_IDS)[number]

const FIXTURE_SET: ReadonlySet<string> = new Set<string>(FIXTURE_IDS)

export function isFixtureId(value: unknown): value is FixtureId {
  return typeof value === 'string' && FIXTURE_SET.has(value)
}

/** What each fixture demonstrates, shown in the local-preview notice. */
export const FIXTURE_DESCRIPTION: Readonly<Record<FixtureId, string>> = {
  preview: 'One name in every lifecycle status, scanned within its expected schedule.',
  stale: 'The same names, scanned three days earlier, so every staleness warning fires.',
}

export interface FixturePayload {
  readonly snapshot: unknown
  readonly latest: unknown
}

const LOADERS: Readonly<Record<FixtureId, () => Promise<FixturePayload>>> = {
  preview: async () => {
    const [snapshot, latest] = await Promise.all([
      import('../../../data/fixtures/preview/snapshot.json'),
      import('../../../data/fixtures/preview/latest.json'),
    ])
    return { snapshot: snapshot.default, latest: latest.default }
  },
  stale: async () => {
    const [snapshot, latest] = await Promise.all([
      import('../../../data/fixtures/stale/snapshot.json'),
      import('../../../data/fixtures/stale/latest.json'),
    ])
    return { snapshot: snapshot.default, latest: latest.default }
  },
}

/** Loads one fixture's snapshot document and latest pointer, unvalidated. */
export function loadFixture(id: FixtureId): Promise<FixturePayload> {
  return LOADERS[id]()
}
