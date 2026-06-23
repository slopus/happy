import type { AgentState } from '@/sync/storageTypes';

export function getPendingPermissionRequestIds(agentState: AgentState | null | undefined): string[] {
    const requests = agentState?.requests ?? {};
    const completedRequests = agentState?.completedRequests ?? {};
    return Object.keys(requests).filter(requestId => !completedRequests[requestId]);
}

export function hasPendingPermissionRequests(agentState: AgentState | null | undefined): boolean {
    return getPendingPermissionRequestIds(agentState).length > 0;
}
