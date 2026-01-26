import type { CapabilitiesDetectRequest, CapabilityId, CapabilityDetectResult } from '@/sync/capabilitiesProtocol';

import type { AgentId } from './registryCore';
import { getAgentCore } from './registryCore';

type CapabilityResults = Partial<Record<CapabilityId, CapabilityDetectResult>>;

export function readAcpLoadSessionSupport(agentId: AgentId, results: CapabilityResults | undefined): boolean {
    const capId = `cli.${getAgentCore(agentId).cli.detectKey}` as CapabilityId;
    const result = results?.[capId];
    if (!result || !result.ok) return false;
    const data = result.data as any;
    return data?.acp?.ok === true && data?.acp?.loadSession === true;
}

export type AcpLoadSessionSupport = Readonly<{
    kind: 'supported' | 'unsupported' | 'error' | 'unknown';
    code?: 'cliNotDetected' | 'capabilityProbeFailed' | 'acpProbeFailed' | 'loadSessionFalse';
    rawMessage?: string;
}>;

export function describeAcpLoadSessionSupport(agentId: AgentId, results: CapabilityResults | undefined): AcpLoadSessionSupport {
    const capId = `cli.${getAgentCore(agentId).cli.detectKey}` as CapabilityId;
    const result = results?.[capId];
    if (!result) return { kind: 'unknown' };
    if (!result.ok) return { kind: 'error', code: 'capabilityProbeFailed', rawMessage: result.error?.message };

    const data = result.data as any;
    if (data?.available !== true) return { kind: 'unsupported', code: 'cliNotDetected' };

    const acp = data?.acp;
    if (!(acp && typeof acp === 'object')) return { kind: 'unknown' };
    if (acp.ok === false) return { kind: 'error', code: 'acpProbeFailed', rawMessage: acp.error?.message };

    const loadSession = acp.ok === true && acp.loadSession === true;
    return loadSession
        ? { kind: 'supported' }
        : { kind: 'unsupported', code: 'loadSessionFalse' };
}

export function buildAcpLoadSessionPrefetchRequest(agentId: AgentId): CapabilitiesDetectRequest {
    const capId = `cli.${getAgentCore(agentId).cli.detectKey}` as CapabilityId;
    return {
        requests: [
            {
                id: capId,
                params: { includeAcpCapabilities: true, includeLoginStatus: true },
            },
        ],
    };
}

export function shouldPrefetchAcpCapabilities(agentId: AgentId, results: CapabilityResults | undefined): boolean {
    const capId = `cli.${getAgentCore(agentId).cli.detectKey}` as CapabilityId;
    const result = results?.[capId];
    const data = result && result.ok ? (result.data as any) : null;
    const acp = data?.acp;

    // If the CLI itself isn't available, ACP probing can't succeed and we should not spin.
    if (data && data.available !== true) return false;

    // If ACP was never requested, it should be missing entirely.
    if (!(acp && typeof acp === 'object')) return true;

    // If the probe succeeded, don't re-probe.
    if (acp.ok === true) return false;

    // Probe can fail transiently (timeouts, temporary stdout pollution, agent cold starts).
    // Retry after a short delay instead of caching a failure for 24h.
    const retryAfterMs = 30_000;
    const checkedAt = typeof acp.checkedAt === 'number'
        ? acp.checkedAt
        : typeof result?.checkedAt === 'number'
            ? result.checkedAt
            : 0;
    if (!checkedAt) return true;
    return (Date.now() - checkedAt) >= retryAfterMs;
}
