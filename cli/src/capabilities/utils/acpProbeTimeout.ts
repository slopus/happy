const DEFAULT_ACP_PROBE_TIMEOUT_MS = 8_000;

import type { CatalogAgentId } from '@/backends/types';

function parseTimeoutMs(raw: string | undefined): number | null {
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
}

export function resolveAcpProbeTimeoutMs(agentName: CatalogAgentId): number {
    const perAgent = parseTimeoutMs(process.env[`HAPPY_ACP_PROBE_TIMEOUT_${agentName.toUpperCase()}_MS`]);
    if (typeof perAgent === 'number') return perAgent;

    const global = parseTimeoutMs(process.env.HAPPY_ACP_PROBE_TIMEOUT_MS);
    if (typeof global === 'number') return global;

    return DEFAULT_ACP_PROBE_TIMEOUT_MS;
}
