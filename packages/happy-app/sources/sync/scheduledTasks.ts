/** Screen-scoped scheduling state. Refreshes follow user actions/socket events, never a timer. */
import { ScheduledTaskSchema, ScheduledRunSchema, ScheduledTaskConfigSchema, type ScheduledTask, type ScheduledTaskConfig,
    type ScheduledTaskInput, type ScheduledRun } from '@slopus/happy-wire';
import type { AuthCredentials } from '@/auth/tokenStorage';
import type { Encryption } from '@/sync/encryption/encryption';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';

export interface DecryptedScheduledTask extends ScheduledTask { config: ScheduledTaskConfig | null }
export interface ScheduledTasksSnapshot { tasks: DecryptedScheduledTask[]; loading: boolean; error: string | null; revision: number; histories: Record<string, ScheduledRun[]> }
export class ScheduledTasksRequestError extends Error { constructor(public readonly code: string) { super(code); } }

export function createScheduledTasksController(getCredentials: () => AuthCredentials | undefined, getEncryption: () => Encryption | undefined) {
    let state: ScheduledTasksSnapshot = { tasks: [], loading: false, error: null, revision: 0, histories: {} };
    let owner: AuthCredentials | undefined, visible = false, sequence = 0;
    let accountGeneration = 0;
    const listeners = new Set<() => void>();
    const historySequences = new Map<string, number>();
    const publish = (patch: Partial<ScheduledTasksSnapshot>) => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
    async function request(path: string, method = 'GET', body?: unknown) {
        const credentials = getCredentials();
        const server = getServerUrl(), generation = accountGeneration;
        if (!credentials || credentials !== owner) throw new ScheduledTasksRequestError('authentication-required');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetch(`${server.replace(/\/$/, '')}/v1/scheduled-tasks${path}`, { method, signal: controller.signal,
                cache: 'no-store', headers: { Authorization: `Bearer ${credentials.token}`, 'X-Happy-Client': getHappyClientId(),
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            const value = await response.json().catch(() => null);
            if (generation !== accountGeneration || server !== getServerUrl() || credentials !== owner || credentials !== getCredentials()) throw new ScheduledTasksRequestError('account-changed');
            if (!response.ok) throw new ScheduledTasksRequestError(response.status === 404 && path === '' ? 'server-unavailable' : typeof value?.error === 'string' ? value.error : 'request-failed');
            return value;
        } catch (error) { if (error instanceof ScheduledTasksRequestError) throw error; throw new ScheduledTasksRequestError('network-error'); }
        finally { clearTimeout(timeout); }
    }
    async function refresh(force = false): Promise<void> {
        if ((!visible && !force) || !owner) return;
        const currentOwner = owner, current = ++sequence;
        publish({ loading: true });
        try {
            const raw = await request('');
            const tasks = await Promise.all(ScheduledTaskSchema.array().parse(raw.tasks).map(async task => {
                const encryption = getEncryption()?.getMachineEncryption(task.machineId);
                const parsed = ScheduledTaskConfigSchema.safeParse(encryption ? await encryption.decryptRaw(task.encryptedConfig) : null);
                return { ...task, config: parsed.success ? parsed.data : null };
            }));
            if (current === sequence && currentOwner === owner) publish({ tasks, loading: false, error: null, revision: state.revision + 1 });
        } catch (error) {
            if (current === sequence && currentOwner === owner) publish({ loading: false, error: error instanceof ScheduledTasksRequestError ? error.code : 'request-failed' });
        }
    }
    return {
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        getSnapshot: () => state,
        beginAccount() { owner = getCredentials(); sequence++; accountGeneration++; historySequences.clear(); publish({ tasks: [], histories: {}, loading: false, error: null, revision: 0 }); if (visible) void refresh(); },
        setVisible(value: boolean) { visible = value; if (value) void refresh(); },
        refresh,
        async history(taskId: string) {
            const captured = owner;
            const sequence = (historySequences.get(taskId) ?? 0) + 1;
            historySequences.set(taskId, sequence);
            const value = await request(`/${taskId}/runs`);
            if (captured !== owner || sequence !== historySequences.get(taskId)) return;
            const runs = ScheduledRunSchema.array().parse(value.runs);
            if (captured === owner) publish({ histories: { ...state.histories, [taskId]: runs } });
        },
        async save(input: Omit<ScheduledTaskInput, 'encryptedConfig'>, config: ScheduledTaskConfig, expectedVersion: number, resetBinding = false) {
            const captured = owner;
            const encryption = getEncryption()?.getMachineEncryption(input.machineId);
            if (!encryption) throw new ScheduledTasksRequestError('encryption-unavailable');
            const encryptedConfig = await encryption.encryptRaw(ScheduledTaskConfigSchema.parse(config));
            if (captured !== owner) throw new ScheduledTasksRequestError('account-changed');
            await request(`/${input.id}`, 'PUT', { ...input, encryptedConfig, expectedVersion, resetBinding });
            await refresh(true);
        },
        async toggle(task: ScheduledTask, enabled = !task.enabled) {
            const { id, machineId, rule, encryptedConfig, newChatEachRun, notificationPolicy } = task;
            await request(`/${id}`, 'PUT', { id, machineId, rule, encryptedConfig, enabled, newChatEachRun, notificationPolicy, expectedVersion: task.version });
            await refresh(true);
        },
        async remove(task: ScheduledTask) { await request(`/${task.id}`, 'DELETE', { expectedVersion: task.version }); await refresh(true); },
        async runNow(taskId: string, requestId: string) { await request(`/${taskId}/run`, 'POST', { requestId }); await refresh(true); await this.history(taskId); },
        async abandon(taskId: string, runId: string) { await request(`/${taskId}/runs/${runId}/abandon`, 'POST', {}); await refresh(true); await this.history(taskId); },
    };
}
