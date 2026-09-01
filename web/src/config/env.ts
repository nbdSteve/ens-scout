import { isFixtureId, type FixtureId } from '../data/fixtures'

/**
 * Build-time configuration.
 *
 * Vite inlines every `VITE_*` variable into the shipped bundle, so this is a
 * public surface: only the read API's base URL belongs here. A Graph endpoint, a
 * Graph API key, or an AWS credential put in a `VITE_*` variable would be
 * readable by anyone who opened the JavaScript. The browser never talks to The
 * Graph or to DynamoDB - it reads one published snapshot from the read API, or
 * from the committed fixtures - so it has no use for any of them.
 */
export interface AppConfig {
  /** Read API origin or path prefix. Null selects fixture mode. */
  readonly apiBaseUrl: string | null
  /** Fixture to serve when no API is configured. */
  readonly fixtureId: FixtureId
}

/** The fixture a clean clone gets when nothing is configured. */
export const DEFAULT_FIXTURE: FixtureId = 'preview'

function normalizeBaseUrl(raw: string | undefined): string | null {
  const value = (raw ?? '').trim()
  if (value === '') {
    return null
  }
  // Requests are built by appending a path, so a trailing slash would produce a
  // doubled separator that some servers treat as a different resource.
  return value.replace(/\/+$/, '')
}

export function readConfig(env: {
  readonly VITE_API_BASE_URL?: string | undefined
  readonly VITE_FIXTURE?: string | undefined
}): AppConfig {
  const fixture = env.VITE_FIXTURE?.trim()
  return {
    apiBaseUrl: normalizeBaseUrl(env.VITE_API_BASE_URL),
    fixtureId: isFixtureId(fixture) ? fixture : DEFAULT_FIXTURE,
  }
}

export const appConfig: AppConfig = readConfig(import.meta.env)
