import { describe, expect, it } from 'vitest'
import { readConfig } from './env'

describe('the production API base', () => {
  it('keeps a root path in API mode and normalizes it to same-origin URLs', () => {
    const config = readConfig({ VITE_API_BASE_URL: '/' })
    expect(config.apiBaseUrl).toBe('')
  })
})
