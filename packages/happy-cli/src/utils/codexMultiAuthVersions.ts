// Installation default is independent of the tested runtime compatibility set.
export const CODEX_MULTI_AUTH_VERSION = '2.16.0'
export const SUPPORTED_CODEX_MULTI_AUTH_VERSIONS = ['2.16.0', '2.17.0'] as const

export function isSupportedCodexMultiAuthVersion(version: unknown): version is string {
  return typeof version === 'string'
    && SUPPORTED_CODEX_MULTI_AUTH_VERSIONS.some((supported) => supported === version)
}
