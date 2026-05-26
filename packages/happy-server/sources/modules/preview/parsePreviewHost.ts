/**
 * Parse the iframe Host header used by the subdomain-origin-isolation
 * mode. See specs/preview-iframe-origin-isolation-subdomain/.
 *
 * Format: `<uuid>-<port>.preview.<zone>` where `<zone>` is any DNS suffix
 * (saycode.ai, staging.saycode.ai, localhost:3005, …) — the production
 * wildcard `*.preview.saycode.ai` is what makes this an isolated origin.
 *
 * The UUID match is strict (8-4-4-4-12 hex) so an attacker can't smuggle
 * arbitrary host fragments through. Port is validated to the standard
 * TCP range; daemon already rejects out-of-range ports on its side too.
 */

const HOST_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(\d{1,5})\.preview\./i;

export interface ParsedPreviewHost {
    machineId: string;
    port: number;
}

export function parsePreviewHost(host: string | undefined): ParsedPreviewHost | null {
    if (!host) return null;
    const m = host.match(HOST_RE);
    if (!m) return null;
    const port = Number.parseInt(m[2], 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { machineId: m[1].toLowerCase(), port };
}
