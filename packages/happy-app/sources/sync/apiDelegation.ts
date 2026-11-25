import { DelegationRequestSchema, DelegationResponseSchema, type DelegationRequest, type DelegationResponse,
    MachineDelegationRolesRequestSchema, MachineDelegationRolesResponseSchema,
    type MachineDelegationRolesRequest, type DelegationRoleCreateInput, type DelegationRolePatch,
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
    // Existing parent-owned results use the backend's inspection-only read,
    // including after worker exit or a lossy older client's metadata write.
    // Every other action still needs the live worker's declared capability.
    const publishedTasks = parent.metadata?.delegationV2?.tasks ?? parent.metadata?.delegatedTasks;
    const canReadPublishedTask = input.action === 'read'
        && parent.metadata?.capabilities?.delegation === undefined
        && (parent.metadata?.delegationV2?.version === 2 || parent.metadata?.delegationProtocol === 1)
        && publishedTasks?.some(task => task.id === input.taskId && task.parentSessionId === sessionId);
    if (parent.metadata?.capabilities?.delegation !== 1 && !canReadPublishedTask) throw new Error(t('delegation.protocolHint'));
    const machine = storage.getState().machines[machineId];
    if (!machine?.active) throw new Error(t('delegation.offline'));
    if (machine.metadata?.delegation !== 1) throw new Error(t('delegation.unsupported'));
    const assertCurrent = () => {
        if (owner() !== account || storage.getState().sessions[sessionId]?.metadata?.machineId !== machineId) throw new Error(t('delegation.ownerChanged'));
    };
    // This machine capability is installed with the V2 response protocol.
    // Older daemons use a strict V1 request schema and must not receive new fields.
    const request = DelegationRequestSchema.parse({ ...input, parentSessionId: sessionId,
        ...(machine.metadata?.delegationRoles === 1 ? { protocolVersion: 2 } : {}),
    });
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

type MachineRolesInput = Exclude<MachineDelegationRolesRequest, { action: 'create' }>
    | { action: 'create'; role: DelegationRoleCreateInput };

/** Machine-owned configuration only. This API neither needs a parent session nor dispatches work. */
export async function machineDelegationRolesRequest(machineId: string, input: MachineRolesInput) {
    const account = owner();
    const assertCurrent = () => {
        if (owner() !== account) throw new Error(t('delegation.roleSettingsOwnerChanged'));
        const machine = storage.getState().machines[machineId];
        if (!machine?.active) throw new Error(t('delegation.offline'));
        if (machine.metadata?.delegationRoles !== 1) throw new Error(t('delegation.rolesProtocolHint'));
    };
    assertCurrent();
    const request = MachineDelegationRolesRequestSchema.parse(input);
    const raw = await apiSocket.machineRPC<unknown, MachineDelegationRolesRequest>(machineId, 'delegation-roles', request, {
        isCurrent: () => { try { assertCurrent(); return true; } catch { return false; } },
    });
    assertCurrent();
    const parsed = MachineDelegationRolesResponseSchema.safeParse(raw);
    if (!parsed.success) throw new Error(t('delegation.roleSettingsInvalidResponse'));
    const response = parsed.data;
    if (!response.success) throw new Error(response.error || t('delegation.requestFailed'));
    const roles = response.roles;
    if (!roles || response.task || response.taskId || new Set(roles.map(role => role.id)).size !== roles.length) {
        throw new Error(t('delegation.roleSettingsInvalidResponse'));
    }
    if (request.action === 'create' || request.action === 'update') {
        const role = response.role;
        const expectedId = request.action === 'create' ? request.role.id : request.roleId;
        const expected = request.action === 'create' ? request.role : request.patch;
        if (!role || (expectedId && role.id !== expectedId)
            || !roles.some(item => JSON.stringify(item) === JSON.stringify(role))
            || Object.entries(expected).some(([key, value]) => key !== 'id'
                && role[key as keyof DelegationRole] !== (value === null ? undefined : value))) {
            throw new Error(t('delegation.roleSettingsInvalidResponse'));
        }
    }
    if (request.action === 'delete' && roles.some(role => role.id === request.roleId)) throw new Error(t('delegation.roleSettingsInvalidResponse'));
    return { ...response, roles };
}

export async function listMachineDelegationRoles(machineId: string): Promise<DelegationRole[]> {
    return (await machineDelegationRolesRequest(machineId, { action: 'list' })).roles;
}
export async function createMachineDelegationRole(machineId: string, role: DelegationRoleCreateInput) {
    const response = await machineDelegationRolesRequest(machineId, { action: 'create', role });
    return { role: response.role!, roles: response.roles };
}
export async function updateMachineDelegationRole(machineId: string, roleId: string, patch: DelegationRolePatch) {
    const response = await machineDelegationRolesRequest(machineId, { action: 'update', roleId, patch });
    return { role: response.role!, roles: response.roles };
}
export async function deleteMachineDelegationRole(machineId: string, roleId: string): Promise<DelegationRole[]> {
    return (await machineDelegationRolesRequest(machineId, { action: 'delete', roleId })).roles;
}
