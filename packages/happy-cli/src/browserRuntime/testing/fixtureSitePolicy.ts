/**
 * Site policy for the synthetic PoC fixture (harness mode and unit tests only).
 * It reproduces the PoC classifier exactly: risky accessible names and the
 * fixture's risky form/page paths need approval, everything else is automatic.
 * A real deployment configures its own `sites`; unmatched writes then need the user.
 */
import type { SitePolicy } from '../policy'

const RISKY_PATHS = ['/risky-submit', '/api/risky']
const CLICKS: Array<'submit' | 'form-click' | 'click'> = ['submit', 'form-click', 'click']

export function fixtureSitePolicies(origins: string[]): SitePolicy[] {
    return origins.map((origin) => ({
        origin,
        actions: [
            { match: { kinds: [...CLICKS, 'link'], namePrefixes: ['pay', 'buy now', 'send', 'submit order', 'confirm payment'] }, risk: 'requires-approval' },
            { match: { kinds: CLICKS, roles: ['button', 'submit'], targetPaths: RISKY_PATHS }, risk: 'requires-approval' },
            { match: { kinds: CLICKS, roles: ['button', 'submit'], pagePaths: RISKY_PATHS }, risk: 'requires-approval' },
            { match: {}, risk: 'auto' },
        ],
    }))
}
