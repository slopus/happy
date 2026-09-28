const PRODUCTION_ORIGIN = 'https://47.115.228.20:8443';
const STAGING_ORIGIN = 'https://47.115.228.20:8444';

/** Keep AgentParty deep links within the authenticated Paws Web environment. */
export function pawsWebOrigin(current?: string): string {
  const origin = current ?? (typeof location === 'undefined' ? '' : location.origin);
  return origin === STAGING_ORIGIN ? STAGING_ORIGIN : PRODUCTION_ORIGIN;
}

/** The account picker matches server URLs exactly, so map the shared gateway to this site. */
export function pawsAccountServerUrl(serverUrl: string, current?: string): string {
  if (pawsWebOrigin(current) !== STAGING_ORIGIN) return serverUrl;
  try {
    const parsed = new URL(serverUrl);
    if (parsed.origin === PRODUCTION_ORIGIN && parsed.pathname === '/' && !parsed.search && !parsed.hash) {
      return STAGING_ORIGIN;
    }
  } catch { /* Keep custom server URLs unchanged. */ }
  return serverUrl;
}
