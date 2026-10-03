import { describe, expect, it } from 'vitest'

import { isSupportedCodexMultiAuthVersion } from './codexMultiAuthVersions'

describe('isSupportedCodexMultiAuthVersion', () => {
  it.each(['2.16.0', '2.17.0', '2.17.3', '2.19.0', '2.100.0', '3.0.0'])('accepts the minimum and every newer release: %s', (version) => {
    expect(isSupportedCodexMultiAuthVersion(version)).toBe(true)
  })

  it.each(['2.15.9', '2.15.0', '2.8.4', '1.99.99'])('rejects releases older than the minimum: %s', (version) => {
    expect(isSupportedCodexMultiAuthVersion(version)).toBe(false)
  })

  it.each(['unknown', '', '2.19', '2.19.0-beta.1', 'v2.19.0', ' 2.19.0', undefined, null, 2.19])('rejects values that are not a plain release version: %s', (version) => {
    expect(isSupportedCodexMultiAuthVersion(version)).toBe(false)
  })
})
