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
    // If acp was already requested (successfully or not), it should be an object.
    return !(data?.acp && typeof data.acp === 'object');
}
