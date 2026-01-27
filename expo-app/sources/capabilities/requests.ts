import type { CapabilitiesDetectRequest } from '@/sync/capabilitiesProtocol';
import { AGENT_IDS, getAgentCore } from '@/agents/catalog';

function buildCliLoginStatusOverrides(): Record<string, { params: { includeLoginStatus: true } }> {
    const overrides: Record<string, { params: { includeLoginStatus: true } }> = {};
    for (const agentId of AGENT_IDS) {
        overrides[`cli.${getAgentCore(agentId).cli.detectKey}`] = { params: { includeLoginStatus: true } };
    }
    return overrides;
}

export const CAPABILITIES_REQUEST_NEW_SESSION: CapabilitiesDetectRequest = {
    checklistId: 'new-session',
};

export const CAPABILITIES_REQUEST_NEW_SESSION_WITH_LOGIN_STATUS: CapabilitiesDetectRequest = {
    checklistId: 'new-session',
    overrides: buildCliLoginStatusOverrides() as any,
};

export const CAPABILITIES_REQUEST_MACHINE_DETAILS: CapabilitiesDetectRequest = {
    checklistId: 'machine-details',
    overrides: buildCliLoginStatusOverrides() as any,
};

export const CAPABILITIES_REQUEST_RESUME_CODEX: CapabilitiesDetectRequest = {
    checklistId: 'resume.codex',
};

export const CAPABILITIES_REQUEST_RESUME_GEMINI: CapabilitiesDetectRequest = {
    checklistId: 'resume.gemini',
};
