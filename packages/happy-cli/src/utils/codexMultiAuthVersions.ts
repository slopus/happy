// Installation default is independent of the tested runtime compatibility set.
export const CODEX_MULTI_AUTH_VERSION = '2.16.0'
// Newer releases are accepted. Users and other tools upgrade the global package
// outside Happy's control, and an exact allow-list turned every such upgrade into
// a Codex outage. The data contract stays guarded separately: bundles must still
// carry OAuth account store v3 and settings v1, and a proxy module that no longer
// loads fails the session start with its own error.
export const MINIMUM_CODEX_MULTI_AUTH_VERSION = '2.16.0'
export const SUPPORTED_CODEX_MULTI_AUTH_VERSION_RANGE = `>=${MINIMUM_CODEX_MULTI_AUTH_VERSION}`

const RELEASE_VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/

function parseReleaseVersion(version: unknown): [number, number, number] | null {
  if (typeof version !== 'string') return null
  const match = RELEASE_VERSION.exec(version)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

const MINIMUM_RELEASE = parseReleaseVersion(MINIMUM_CODEX_MULTI_AUTH_VERSION)!

export function isSupportedCodexMultiAuthVersion(version: unknown): version is string {
  const parsed = parseReleaseVersion(version)
  if (!parsed) return false
  for (let i = 0; i < 3; i++) {
    if (parsed[i] !== MINIMUM_RELEASE[i]) return parsed[i] > MINIMUM_RELEASE[i]
  }
  return true
}
