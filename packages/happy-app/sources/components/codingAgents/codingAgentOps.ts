import { CodingAgentsInspectResponseSchema, CodingAgentUpdateResponseSchema, type CodingAgentId } from '@slopus/happy-wire';
import { apiSocket } from '@/sync/apiSocket';
export async function inspectCodingAgents(machineId: string, checkUpdates: boolean) {
    return CodingAgentsInspectResponseSchema.parse(await apiSocket.machineRPC(machineId, 'coding-agents-inspect', { checkUpdates }, { timeoutMs: 90_000 }));
}
export async function updateCodingAgent(machineId: string, id: CodingAgentId, updateToken: string) {
    return CodingAgentUpdateResponseSchema.parse(await apiSocket.machineRPC(machineId, 'coding-agent-update', { id, updateToken }, { timeoutMs: 9 * 60_000 }));
}
