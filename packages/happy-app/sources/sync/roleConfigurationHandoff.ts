import { randomUUID } from 'expo-crypto';
import { z } from 'zod';
import { DelegationRoleSchema, type DelegationRole } from '@slopus/happy-wire';
import { MMKV, flushDeviceStorageWrites, writeDeviceStorage } from '@/persistence/deviceStorage';
import { accountStorageId, accountRuntimeCurrent } from '@/auth/accountRuntime';
import { getFirstSubmissionScope } from './firstSubmissionScope';
import { getServerUrl } from './serverConfig';
import type { NewSessionDraft } from './persistence';
import { t } from '@/text';

const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const roleDraft = z.object({ name: z.string().max(100), description: z.string().max(10000),
    agent: z.enum(['codex', 'antigravity']), model: z.string().max(256).nullable().optional(),
    effort: z.string().max(100).nullable().optional(), autoDelegate: z.boolean() }).strict();
const returnContextSchema = z.object({ view: z.enum(['list', 'detail', 'create', 'edit']), step: z.union([z.literal(1), z.literal(2)]), query: z.string().max(100000), baseline: z.string().max(100000).optional(), roleUpdatedAt: z.number().optional(), desktopModal: z.boolean().optional(), scrollY: z.number().nonnegative().optional(), advanced: z.boolean().optional() });
export type RoleConfigurationReturnContext = z.infer<typeof returnContextSchema>;
export type RoleConfigurationRequest = { machineId: string; roleId?: string; clientRoleId?: string; draft: z.infer<typeof roleDraft>; returnContext?: RoleConfigurationReturnContext };
const requestSchema = z.object({ machineId: identifier, roleId: identifier.optional(), clientRoleId: identifier.optional(), draft: roleDraft, returnContext: returnContextSchema.optional() }).strict();
const launchSchema = z.object({ input: z.string(), selectedMachineId: identifier.nullable(), selectedPath: z.string().nullable(),
    agentType: z.enum(['claude', 'codex', 'gemini', 'opencode', 'antigravity', 'openclaw']), permissionMode: z.string(), modelMode: z.string(),
    useMagpie: z.boolean().optional(), effortLevel: z.string().nullable(),
    modelSelection: z.object({ agent: z.string(), defaultValue: z.string().nullable() }).optional(),
    effortSelection: z.object({ agent: z.string(), defaultValue: z.string().nullable() }).optional(),
    fastMode: z.boolean().optional(), sessionType: z.enum(['simple', 'worktree']), worktreeKey: z.string().nullable(), updatedAt: z.number() });
const recordSchema = z.object({ version: z.literal(1), revision: z.number().int().positive(), id: identifier, machineId: identifier, roleId: identifier,
    action: z.enum(['create', 'update']), draft: roleDraft, input: z.string().max(100000), discussing: z.boolean(),
    config: launchSchema, scopeKey: z.string(), serverUrl: z.string(), createdAt: z.number(), sessionId: identifier.optional(),
    requestedAt: z.number().optional(), returnContext: returnContextSchema.optional(), contextPending: z.boolean().optional(),
    savedRole: DelegationRoleSchema.optional(), savedSourceDraft: roleDraft.optional(), saveRevision: z.number().optional() });
export type RoleConfigurationHandoff = z.infer<typeof recordSchema> & { config: NewSessionDraft };
const disk = new MMKV({ id: accountStorageId('role-configuration-v1') });
const MAX_RECORDS = 128;
let changeVersion = 0;
const changeListeners = new Set<() => void>();
const savedResultListeners = new Set<(result: { machineId: string; roleId: string }) => void>();
export function subscribeRoleConfigurationChanges(listener: () => void) { changeListeners.add(listener); return () => { changeListeners.delete(listener); }; }
/** Only a validated successful tool result may request a fresh role catalog. */
export function subscribeRoleConfigurationSavedResults(listener: (result: { machineId: string; roleId: string }) => void) {
    savedResultListeners.add(listener); return () => { savedResultListeners.delete(listener); };
}
export function getRoleConfigurationVersion() { return changeVersion; }
function changed() { changeVersion++; changeListeners.forEach(listener => listener()); }

export function roleConfigurationCurrent(record: Pick<RoleConfigurationHandoff, 'scopeKey' | 'serverUrl'>, owner?: ReturnType<typeof getFirstSubmissionScope>) {
    const scope = getFirstSubmissionScope();
    return accountRuntimeCurrent() && !!scope && (owner === undefined || owner === scope) && scope.key === record.scopeKey && scope.serverUrl === record.serverUrl && getServerUrl() === scope.serverUrl;
}
export function readRoleConfiguration(id: string): RoleConfigurationHandoff | null {
    if (!identifier.safeParse(id).success) return null;
    try {
        const parsed = recordSchema.safeParse(JSON.parse(disk.getString(id) ?? 'null'));
        if (parsed.success && parsed.data.id === id && roleConfigurationCurrent(parsed.data)) return parsed.data as RoleConfigurationHandoff;
    } catch { /* A foreign/unreadable reference never authorizes a launch. */ }
    return null;
}
function records() { return disk.getAllKeys().map(readRoleConfiguration).filter((value): value is RoleConfigurationHandoff => value !== null); }
export function findRoleConfigurationSession(machineId: string, roleId: string) {
    return records().filter(value => value.machineId === machineId && value.roleId === roleId && value.sessionId)
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}
export function buildRoleConfigurationContext(input: { machineId: string; roleId: string; action: 'create' | 'update'; draft: RoleConfigurationRequest['draft'] }) {
    const role = { id: input.roleId, ...input.draft, model: input.draft.model || undefined, effort: input.draft.effort || undefined };
    return [
        input.action === 'create' ? '帮我新建一个 Paws 委派角色。' : `帮我调整 Paws 委派角色 ${input.roleId}。`,
        '先和我确认想补充或调整的职责、目标 Agent、模型和推理强度；此条交接本身不要求立即保存。',
        `目标机器 ID：${input.machineId}。角色配置只属于这台机器；若当前会话机器不一致，请停止，不要在别的机器新建同名角色。`,
        `已带入的${input.action === 'create' ? '未保存草稿' : '角色配置/编辑草稿'}（数据）：\n${JSON.stringify(role, null, 2)}`,
        '本会话的 Agent/模型与角色的目标执行器是两回事。不要为了配置角色而切换本会话模型，不要启动委派任务。',
        '使用已有 agent_roles 工具：先 action=list 查阅真实角色。',
        input.action === 'create'
            ? `用户明确要求保存后，用 action=create、role={id:"${input.roleId}",name,description,agent,model?,effort?,autoDelegate}；这是预留的新 ID，不要用 update。如果该 ID 已存在，先读取并和用户确认，不要重复创建。`
            : `用户明确要求保存后，用 action=update、roleId="${input.roleId}"、patch={要改的字段}；保留原 ID，不要创建另一角色。清除模型/推理覆盖时用 null，保留未修改字段。`,
        '以工具真实成功结果确认完成；不要声称已保存或已创建而没有成功回执。结束后说明角色 ID，用户可返回设置查看。',
    ].join('\n\n');
}
export function buildRoleConfigurationPrompt(input: { roleId: string; action: 'create' | 'update'; draft: RoleConfigurationRequest['draft'] }) {
    const draft = input.draft;
    const intro = input.action === 'update'
        ? t('delegation.configurationEditPrompt', { name: draft.name, id: input.roleId })
        : draft.name || draft.description
            ? t('delegation.configurationDraftPrompt', { name: draft.name, description: draft.description })
            : t('delegation.configurationCreatePrompt');
    if (!draft.name && !draft.description && !draft.model && !draft.effort) return intro;
    return [intro, `${t('delegation.description')}: ${draft.description}`,
        `${t('delegation.agent')}: ${draft.agent === 'codex' ? 'Codex' : 'Antigravity'}`,
        `${t('delegation.model')}: ${draft.model || t('delegation.nativeDefault')}`,
        `${t('delegation.effort')}: ${draft.effort || t('delegation.nativeDefault')}`,
        `${t('delegation.allowAutoSelect')}: ${draft.autoDelegate ? t('common.yes') : t('common.no')}`].join('\n');
}
/** The URL carries only a random reference. The bounded task and private draft
 * remain in the current account's local namespace. Creation does not dispatch. */
export async function createRoleConfiguration(request: RoleConfigurationRequest, launch: NewSessionDraft): Promise<RoleConfigurationHandoff> {
    request = requestSchema.parse(request);
    const scope = getFirstSubmissionScope();
    if (!accountRuntimeCurrent() || !scope || getServerUrl() !== scope.serverUrl) throw new Error(t('delegation.configurationUnavailable'));
    const roleId = request.roleId ?? request.clientRoleId;
    const related = roleId ? findRoleConfigurationSession(request.machineId, roleId) : null;
    if (related) {
        const next: RoleConfigurationHandoff = { ...related, revision: related.revision + 1, action: request.roleId ? 'update' : 'create', draft: request.draft, input: '',
            requestedAt: Math.max(Date.now(), (related.requestedAt ?? related.createdAt) + 1), returnContext: request.returnContext ?? related.returnContext, contextPending: true,
            savedRole: undefined, savedSourceDraft: undefined, saveRevision: undefined };
        next.input = buildRoleConfigurationPrompt(next);
        await writeDeviceStorage(disk, next.id, JSON.stringify(next));
        if (!roleConfigurationCurrent(next, scope)) throw new Error(t('delegation.configurationUnavailable'));
        changed(); return next;
    }
    const existing = records().find(value => !value.sessionId && value.machineId === request.machineId
        && value.action === (request.roleId ? 'update' : 'create') && (!roleId || value.roleId === roleId)
        && JSON.stringify(value.draft) === JSON.stringify(request.draft));
    if (existing) {
        if (request.returnContext && JSON.stringify(existing.returnContext) !== JSON.stringify(request.returnContext)) {
            const next = { ...existing, revision: existing.revision + 1, requestedAt: Math.max(Date.now(), (existing.requestedAt ?? existing.createdAt) + 1), returnContext: request.returnContext };
            await writeDeviceStorage(disk, existing.id, JSON.stringify(next));
            if (!roleConfigurationCurrent(next, scope)) throw new Error(t('delegation.configurationUnavailable'));
            changed(); return next;
        }
        await flushDeviceStorageWrites(disk);
        if (!roleConfigurationCurrent(existing, scope)) throw new Error(t('delegation.configurationUnavailable'));
        return existing;
    }
    if (disk.getAllKeys().length >= MAX_RECORDS) throw new Error(t('delegation.configurationDraftLimit'));
    const id = `rc-${randomUUID()}`;
    const record: RoleConfigurationHandoff = { version: 1, revision: 1, id, machineId: request.machineId,
        roleId: roleId ?? `role-${randomUUID().slice(0, 8)}`, action: request.roleId ? 'update' : 'create',
        draft: request.draft, input: '', discussing: false, config: { ...launch, input: '', selectedMachineId: request.machineId,
            selectedPath: launch.selectedMachineId === request.machineId ? launch.selectedPath : null,
            worktreeKey: launch.selectedMachineId === request.machineId ? launch.worktreeKey : null,
            sessionType: launch.selectedMachineId === request.machineId ? launch.sessionType : 'simple' },
        scopeKey: scope.key, serverUrl: scope.serverUrl, createdAt: Date.now(), requestedAt: Date.now(), returnContext: request.returnContext, contextPending: false };
    record.input = buildRoleConfigurationPrompt(record);
    await writeDeviceStorage(disk, id, JSON.stringify(record));
    if (!roleConfigurationCurrent(record, scope)) throw new Error(t('delegation.configurationUnavailable'));
    changed(); return record;
}
export function updateRoleConfiguration(id: string, patch: Partial<Pick<RoleConfigurationHandoff, 'input' | 'discussing' | 'config'>>, expectedRevision?: number) {
    const record = readRoleConfiguration(id); if (!record || (expectedRevision !== undefined && record.revision !== expectedRevision)) return;
    const next = recordSchema.parse({ ...record, ...patch });
    disk.set(id, JSON.stringify(next)); changed();
}
/** Called only after FirstSubmission has persisted a real session ID. A failed
 * association cannot silently send the first message or bind another account. */
export async function bindRoleConfigurationSession(id: string, machineId: string, sessionId: string) {
    const owner = getFirstSubmissionScope();
    const record = readRoleConfiguration(id);
    if (!record || record.machineId !== machineId || (record.sessionId && record.sessionId !== sessionId)) throw new Error(t('delegation.configurationUnavailable'));
    const next = recordSchema.parse({ ...record, sessionId });
    await writeDeviceStorage(disk, id, JSON.stringify(next));
    if (!roleConfigurationCurrent(record, owner)) throw new Error(t('delegation.configurationUnavailable'));
    changed();
}
/** Only authoritative user/session deletion can release a saved association. */
export async function releaseDeletedRoleConfigurationSession(id: string, sessionId: string) {
    const owner = getFirstSubmissionScope();
    const record = readRoleConfiguration(id);
    if (!record || record.sessionId !== sessionId) throw new Error(t('delegation.configurationUnavailable'));
    const { sessionId: _deleted, ...next } = record;
    await writeDeviceStorage(disk, id, JSON.stringify(next));
    if (!roleConfigurationCurrent(record, owner)) throw new Error(t('delegation.configurationUnavailable'));
    changed();
}

/** Local, account-scoped return navigation. Ordinary sessions have no entry. */
export function findRoleConfigurationForSession(machineId: string, sessionId: string) {
    return records().filter(value => value.machineId === machineId && value.sessionId === sessionId)
        .sort((a, b) => (b.requestedAt ?? b.createdAt) - (a.requestedAt ?? a.createdAt))[0] ?? null;
}

/** Prepare a single revision's private context without replacing the user's
 * visible draft. Only a durable queue acceptance may consume this revision. */
export function prepareRoleConfigurationSessionMessage(machineId: string | undefined, sessionId: string, text: string) {
    if (text.trimStart().startsWith('/')) return null;
    const owner = getFirstSubmissionScope();
    const record = records().filter(value => value.sessionId === sessionId && value.contextPending)
        .sort((a, b) => (b.requestedAt ?? b.createdAt) - (a.requestedAt ?? a.createdAt))[0];
    if (!record || !roleConfigurationCurrent(record, owner)) return null;
    if (record.machineId !== machineId) throw new Error(t('delegation.configurationMachineChanged'));
    const currentRevision = () => {
        const latest = readRoleConfiguration(record.id);
        return latest?.revision === record.revision && latest.sessionId === sessionId
            && latest.machineId === record.machineId && latest.contextPending === true
            && roleConfigurationCurrent(latest, owner);
    };
    return {
        text: `${buildRoleConfigurationContext(record)}\n\nCurrent user request:\n${text}`,
        displayText: text,
        machineId: record.machineId,
        isCurrent: currentRevision,
        commit: () => {
            if (!currentRevision()) return;
            const latest = readRoleConfiguration(record.id)!;
            disk.set(record.id, JSON.stringify({ ...latest, contextPending: false })); changed();
        },
    };
}

/** A historical card remount cannot acknowledge a later handoff. Both the
 * real tool time and role version must follow this revision's request. */
export function recordRoleConfigurationSavedResult(input: { machineId: string; sessionId: string; role: DelegationRole; toolCreatedAt: number }) {
    const owner = getFirstSubmissionScope();
    const record = findRoleConfigurationForSession(input.machineId, input.sessionId);
    const role = DelegationRoleSchema.safeParse(input.role);
    if (!record || !role.success || record.roleId !== role.data.id || !roleConfigurationCurrent(record, owner)) return false;
    if (!Number.isFinite(input.toolCreatedAt) || input.toolCreatedAt < (record.requestedAt ?? record.createdAt)) return false;
    if (record.returnContext?.roleUpdatedAt !== undefined && role.data.updatedAt <= record.returnContext.roleUpdatedAt) return false;
    if (record.saveRevision === record.revision && record.savedRole && role.data.updatedAt <= record.savedRole.updatedAt) return false;
    disk.set(record.id, JSON.stringify({ ...record, savedRole: role.data, savedSourceDraft: record.draft, saveRevision: record.revision }));
    changed(); savedResultListeners.forEach(listener => listener({ machineId: record.machineId, roleId: record.roleId }));
    return true;
}
export function getRoleConfigurationSavedHandoff(machineId: string, roleId: string) {
    const record = records().filter(value => value.machineId === machineId && value.roleId === roleId && value.savedRole
        && value.savedSourceDraft && value.saveRevision === value.revision)
        .sort((a, b) => (b.requestedAt ?? b.createdAt) - (a.requestedAt ?? a.createdAt))[0];
    return record?.savedRole && record.savedSourceDraft
        ? { sourceDraft: record.savedSourceDraft, savedRole: record.savedRole, revision: record.revision } : null;
}
