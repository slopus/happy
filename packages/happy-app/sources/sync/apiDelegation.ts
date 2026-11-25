import { DelegationRequestSchema, DelegationResponseSchema, type DelegationRequest, type DelegationResponse,
    type DelegationRole, type DelegationRoleInput, type DelegatedTask } from '@slopus/happy-wire';
import { assertAccountRuntime, getRuntimeAccountSelection } from '@/auth/accountRuntime';
import { t } from '@/text';
import { apiSocket } from './apiSocket';
import { storage } from './storage';

type WithoutParent<T> = T extends { parentSessionId: string } ? Omit<T, 'parentSessionId'> : never;
type AppDelegationRequest = WithoutParent<Exclude<DelegationRequest, { action: 'start' }>>;
function owner(): string {
    assertAccountRuntime();
    const account = getRuntimeAccountSelection();
    return JSON.stringify([account?.key, account?.generation, account?.serverUrl]);
}

/** Single parent-scoped RPCs. Natural-language dispatch remains a main-agent tool call. */
export async function delegationRequest(sessionId: string, input: AppDelegationRequest): Promise<DelegationResponse> {
    const account = owner();
    const parent = storage.getState().sessions[sessionId];
    const machineId = parent?.metadata?.machineId;
    if (!machineId) throw new Error(t('delegation.missingMachine'));
    if (parent?.metadata?.capabilities?.delegation !== 1) throw new Error(t('delegation.protocolHint'));
    const machine = storage.getState().machines[machineId];
    if (!machine?.active) throw new Error(t('delegation.offline'));
    if (machine.metadata?.delegation !== 1) throw new Error(t('delegation.unsupported'));
    const assertCurrent = () => {
        if (owner() !== account || storage.getState().sessions[sessionId]?.metadata?.machineId !== machineId) throw new Error(t('delegation.ownerChanged'));
    };
    const request = DelegationRequestSchema.parse({ ...input, parentSessionId: sessionId });
    assertCurrent();
    const raw = await apiSocket.machineRPC<unknown, DelegationRequest>(machineId, 'delegation', request);
    assertCurrent();
    const parsed = DelegationResponseSchema.safeParse(raw);
    if (!parsed.success) throw new Error(t('delegation.invalidResponse'));
    const response = parsed.data;
    if (!response.success) throw new Error(response.error || t('delegation.requestFailed'));
    if (response.task && (response.task.parentSessionId !== sessionId || ('taskId' in input && response.task.id !== input.taskId))) throw new Error(t('delegation.invalidResponse'));
    return response;
}
export async function listDelegationRoles(sessionId: string): Promise<DelegationRole[]> {
    const response = await delegationRequest(sessionId, { action: 'roles-list' });
    if (!response.roles) throw new Error(t('delegation.invalidResponse'));
    return response.roles;
}
export async function saveDelegationRole(sessionId: string, role: DelegationRoleInput): Promise<DelegationRole> {
    const response = await delegationRequest(sessionId, { action: 'roles-save', role });
    const saved = response.role ?? response.roles?.find(item => item.id === role.id);
    if (!saved || saved.id !== role.id) throw new Error(t('delegation.invalidResponse'));
    return saved;
}
export async function deleteDelegationRole(sessionId: string, roleId: string): Promise<DelegationRole[] | undefined> {
    return (await delegationRequest(sessionId, { action: 'roles-delete', roleId })).roles;
}
export async function readDelegatedTask(sessionId: string, taskId: string): Promise<DelegatedTask> {
    const response = await delegationRequest(sessionId, { action: 'read', taskId });
    if (!response.task) throw new Error(t('delegation.invalidResponse'));
    return response.task;
}
export async function cancelDelegatedTask(sessionId: string, taskId: string): Promise<DelegatedTask | undefined> {
    return (await delegationRequest(sessionId, { action: 'cancel', taskId })).task;
}
