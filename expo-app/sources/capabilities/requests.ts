import type { CapabilitiesDetectRequest } from '@/sync/capabilitiesProtocol';
import { AGENT_IDS, getAgentCore } from '@/agents/catalog';
import { CHECKLIST_IDS } from '@happy/protocol/checklists';

function buildCliLoginStatusOverrides(): Record<string, { params: { includeLoginStatus: true } }> {
    const overrides: Record<string, { params: { includeLoginStatus: true } }> = {};
    for (const agentId of AGENT_IDS) {
        overrides[`cli.${getAgentCore(agentId).cli.detectKey}`] = { params: { includeLoginStatus: true } };
    }
    return overrides;
}

export const CAPABILITIES_REQUEST_NEW_SESSION: CapabilitiesDetectRequest = {
    checklistId: CHECKLIST_IDS.NEW_SESSION,
};

export const CAPABILITIES_REQUEST_MACHINE_DETAILS: CapabilitiesDetectRequest = {
    checklistId: CHECKLIST_IDS.MACHINE_DETAILS,
    overrides: buildCliLoginStatusOverrides() as any,
};
