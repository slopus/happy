import { CapabilityCatalogSchema, ServiceConfigurationSchema, ServiceConfigSchema, ServiceTargetSchema } from '@slopus/happy-wire/ai-services';
import type { CapabilityCatalog, ServiceConfiguration, ServicePermissionMode, ServiceReasoning, ServiceTarget, ServiceTier } from '@slopus/happy-wire/ai-services';
import { AIServiceClientError, type BindingOverrides, type ClientErrorCode, type ServiceConnection, type ServiceSource } from './types';
import { safeServiceError } from './client';

export interface ServiceProfileSlot { id: string; name: string; description?: string }
export interface ServiceProfileValue {
    target?: ServiceTarget;
    modelId?: string | null;
    reasoning?: ServiceReasoning;
    permissionMode?: ServicePermissionMode;
    serviceTier?: ServiceTier;
}
export interface ServiceProfileRow extends ServiceProfileSlot {
    allowModelOverride?: boolean;
    allowReasoningOverride?: boolean;
    loading?: boolean;
    error?: string;
    value: ServiceProfileValue;
    targets: ServiceConfiguration['targets'];
    catalog: CapabilityCatalog | null;
}
export interface ServiceProfilesScope { source: ServiceSource; serviceId: string; connectionId: string }
export interface ServiceProfilesRecord { version: 1; slots: Record<string, ServiceProfileValue> }
export interface ServiceProfilesClient {
    source: ServiceSource;
    services: { configuration(): Promise<ServiceConfiguration> };
    capabilities: { read(options: { target: ServiceTarget; signal?: AbortSignal }): Promise<CapabilityCatalog | null> };
}
export interface ServiceProfilesOptions {
    slots: ServiceProfileSlot[];
    client(): ServiceProfilesClient;
    connection(): ServiceConnection | null;
    /** The host must scope this persistence to its verified signed-in subject. */
    read(scope: ServiceProfilesScope): unknown | Promise<unknown>;
    /** Persist this whole record atomically. It contains configuration metadata only. */
    write(scope: ServiceProfilesScope, record: ServiceProfilesRecord): void | Promise<void>;
}
export interface ServiceProfilesState {
    source: ServiceSource | null;
    serviceId: string | null;
    connectionId: string | null;
    editing: boolean;
    loading: boolean;
    saving: boolean;
    rows: ServiceProfileRow[];
    error: ClientErrorCode | null;
}
export interface ServiceProfiles {
    begin(): Promise<void>;
    getState(): ServiceProfilesState;
    subscribe(listener: (state: ServiceProfilesState) => void): () => void;
    update(id: string, patch: Partial<ServiceProfileValue>): void;
    refresh(id: string): Promise<void>;
    save(): Promise<void>;
    cancel(): void;
    getOverrides(id: string): Promise<BindingOverrides>;
    dispose(): void;
}
const valueKeys = ['target', 'modelId', 'reasoning', 'permissionMode', 'serviceTier'];
const nativeDefaults = { modelId: null, reasoning: { mode: 'default' as const }, permissionMode: 'chat-only' as const, serviceTier: 'default' as const };
const targetKey = (target: ServiceTarget) => JSON.stringify([target.machineId, target.engine, target.accountRef.kind,
    target.accountRef.kind === 'codex-profile' ? target.accountRef.id : target.accountRef.identityId]);
const fail = (code: ClientErrorCode): never => { throw new AIServiceClientError(code); };
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function targetOf(config: ServiceConfiguration['defaults']): ServiceTarget {
    return ServiceTargetSchema.parse({ machineId: config.machineId, engine: config.engine, accountRef: config.accountRef });
}
function profileValue(value: unknown, defaults: ServiceProfileValue): ServiceProfileValue {
    if (!plain(value) || Object.keys(value).some(key => !valueKeys.includes(key))) return fail('invalid-request');
    const merged = { ...defaults, ...value }, target = ServiceTargetSchema.safeParse(merged.target);
    if (!target.success) return fail('invalid-request');
    const parsed = ServiceConfigSchema.safeParse({ ...target.data, modelId: merged.modelId, reasoning: merged.reasoning,
        permissionMode: merged.permissionMode, serviceTier: merged.serviceTier });
    if (!parsed.success) return fail('invalid-request');
    return { target: target.data, modelId: parsed.data.modelId, reasoning: parsed.data.reasoning,
        permissionMode: parsed.data.permissionMode, serviceTier: parsed.data.serviceTier };
}

/** Drafts configure new conversations only. The host owns authentication and subject-scoped persistence. */
export function createServiceProfiles(options: ServiceProfilesOptions): ServiceProfiles {
    const slots = structuredClone(options.slots);
    if (!slots.length || new Set(slots.map(slot => slot.id)).size !== slots.length || slots.some(slot => !slot.id?.trim() || !slot.name?.trim())) fail('invalid-request');
    let state: ServiceProfilesState = { source: null, serviceId: null, connectionId: null, editing: false, loading: false, saving: false, rows: [], error: null };
    let baseline: ServiceProfileRow[] = [], disposed = false, epoch = 0, lifetime = new AbortController();
    let context: { client: ServiceProfilesClient; scope: ServiceProfilesScope; configuration: ServiceConfiguration } | null = null;
    const listeners = new Set<(state: ServiceProfilesState) => void>();
    const revisions = new Map<string, number>(), inflight = new Map<string, Promise<CapabilityCatalog | null>>(), machineQueues = new Map<string, Promise<unknown>>();
    const snapshot = () => structuredClone(state);
    const emit = () => { if (!disposed) for (const listener of listeners) listener(snapshot()); };
    const open = () => { if (disposed) fail('disposed'); };
    const invalidate = () => { epoch++; lifetime.abort(); lifetime = new AbortController(); revisions.clear(); };
    function capture() {
        open();
        const client = options.client(), connection = options.connection();
        if (!connection || connection.source !== client.source) return fail('consent-required');
        return { client, scope: { source: client.source, serviceId: connection.serviceId, connectionId: connection.id } };
    }
    function current(value: ReturnType<typeof capture>) {
        if (disposed) return false;
        const connection = options.connection();
        return options.client() === value.client && connection?.source === value.scope.source && connection.id === value.scope.connectionId && connection.serviceId === value.scope.serviceId;
    }
    function requireDraft() {
        open();
        if (!state.editing || !context || !current(context)) return fail('consent-required');
        if (state.loading || state.saving) return fail('resource-busy');
        return context;
    }
    function slotRow(id: string) { const row = state.rows.find(row => row.id === id); return row ?? fail('invalid-request'); }
    function checkTarget(configuration: ServiceConfiguration, value: ServiceProfileValue) {
        if (!value.target || !configuration.targets.some(entry => targetKey(entry.target) === targetKey(value.target!))) fail('permission-denied');
    }
    function checkPermission(configuration: ServiceConfiguration, value: ServiceProfileValue) {
        if (value.permissionMode && value.permissionMode !== 'chat-only' && !configuration.permissions.includes('tools')) fail('permission-denied');
    }
    function fixedOptions(configuration: ServiceConfiguration, value: ServiceProfileValue): ServiceProfileValue {
        const sameEngine=value.target?.engine===configuration.defaults.engine;
        return {...value,...(!configuration.allowModelOverride ? {modelId:sameEngine?configuration.defaults.modelId:null} : {}),...(!configuration.allowReasoningOverride ? {reasoning:sameEngine?configuration.defaults.reasoning:{mode:'default' as const}} : {})};
    }
    async function load(value: ReturnType<typeof capture>) {
        const parsed = ServiceConfigurationSchema.safeParse(await value.client.services.configuration());
        if (!current(value)) return fail('context-mismatch');
        if (!parsed.success || parsed.data.service.id !== value.scope.serviceId) return fail('context-mismatch');
        const configuration = parsed.data;
        if (!configuration.service.enabled) return fail('service-disabled');
        let saved: unknown;
        try { saved = await options.read(structuredClone(value.scope)); } catch { return fail('storage-unavailable'); }
        if (!current(value)) return fail('context-mismatch');
        if (saved !== undefined && saved !== null && (!plain(saved) || saved.version !== 1 || Object.keys(saved).some(key => !['version', 'slots'].includes(key)) || !plain(saved.slots))) return fail('invalid-service-config');
        const stored = (saved as ServiceProfilesRecord | null | undefined)?.slots ?? {};
        const defaults: ServiceProfileValue = { target: targetOf(configuration.defaults), modelId: configuration.defaults.modelId,
            reasoning: configuration.defaults.reasoning, permissionMode: configuration.defaults.permissionMode ?? 'chat-only', serviceTier: configuration.defaults.serviceTier ?? 'default' };
        const rows: ServiceProfileRow[] = slots.map(slot => ({ ...slot, value: fixedOptions(configuration,profileValue(Object.hasOwn(stored, slot.id) ? stored[slot.id] : {}, defaults)), allowModelOverride:configuration.allowModelOverride, allowReasoningOverride:configuration.allowReasoningOverride, targets: structuredClone(configuration.targets), catalog: null }));
        return { configuration, rows };
    }
    function probe(value: NonNullable<typeof context>, target: ServiceTarget, generation: number) {
        const key = JSON.stringify([generation, value.scope, targetKey(target)]), existing = inflight.get(key);
        if (existing) return existing;
        const machine = JSON.stringify([value.scope, target.machineId]), signal = lifetime.signal;
        const promise = (machineQueues.get(machine) ?? Promise.resolve()).catch(() => undefined).then(async () => {
            if (signal.aborted || !current(value)) return fail('aborted');
            const catalog = await value.client.capabilities.read({ target: structuredClone(target), signal });
            if (catalog === null) return null;
            const parsed = CapabilityCatalogSchema.safeParse(catalog);
            if (!parsed.success || targetKey(parsed.data) !== targetKey(target)) return fail('context-mismatch');
            if (parsed.data.execution && !value.configuration.permissions.includes('tools')) parsed.data.execution.permissionModes = parsed.data.execution.permissionModes.filter(mode => mode === 'chat-only');
            return parsed.data;
        });
        inflight.set(key, promise); machineQueues.set(machine, promise);
        void promise.finally(() => { if (inflight.get(key) === promise) inflight.delete(key); if (machineQueues.get(machine) === promise) machineQueues.delete(machine); }).catch(() => undefined);
        return promise;
    }
    async function refreshRow(id: string, value: NonNullable<typeof context>, generation: number) {
        const row = slotRow(id), revision = (revisions.get(id) ?? 0) + 1;
        revisions.set(id, revision); row.loading = true; row.error = undefined; emit();
        const active = () => !disposed && generation === epoch && current(value) && revisions.get(id) === revision;
        try {
            checkTarget(value.configuration, row.value);
            const catalog = await probe(value, row.value.target!, generation);
            if (active()) { row.catalog = catalog; row.error = catalog?.availability === 'online' ? undefined : 'machine-offline'; }
        } catch (error) { if (active()) { row.catalog = null; row.error = safeServiceError(error).code; } }
        finally { if (active()) { row.loading = false; emit(); } }
    }
    function validateRow(row: ServiceProfileRow, configuration: ServiceConfiguration) {
        checkTarget(configuration, row.value);
        checkPermission(configuration, row.value);
        const catalog = row.catalog;
        if (row.loading) fail('resource-busy');
        if (!catalog || catalog.availability !== 'online') return fail('machine-offline');
        if (targetKey(catalog) !== targetKey(row.value.target!)) fail('context-mismatch');
        const model = catalog.models.find(model => model.id === (row.value.modelId ?? catalog.defaultModelId));
        if (!model) return fail('model-unavailable');
        const reasoning = row.value.reasoning ?? { mode: 'default' };
        if (reasoning.mode === 'default' ? !model.reasoning.supportsDefault : !model.reasoning.values.includes(reasoning.value)) fail('parameter-unsupported');
        if (row.value.permissionMode !== 'chat-only' && !catalog.execution?.permissionModes.includes(row.value.permissionMode!)) fail('parameter-unsupported');
        if (row.value.serviceTier === 'fast' && (!catalog.execution?.serviceTiers.includes('fast') || !model.serviceTiers?.includes('fast'))) fail('parameter-unsupported');
    }
    return {
        getState: snapshot,
        subscribe(listener) { open(); listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
        async begin() {
            open(); if (state.saving) fail('resource-busy');
            const value = capture(); invalidate(); const generation = epoch;
            context = null; baseline = [];
            state = { ...value.scope, editing: true, loading: true, saving: false, rows: [], error: null }; emit();
            try {
                const loaded = await load(value);
                if (disposed || generation !== epoch || !current(value)) return;
                context = { ...value, configuration: loaded.configuration }; state.rows = loaded.rows;
                await Promise.all(slots.map(slot => refreshRow(slot.id, context!, generation)));
                if (disposed || generation !== epoch || !current(value)) return;
                baseline = structuredClone(state.rows); state.loading = false; emit();
            } catch (error) {
                if (disposed || generation !== epoch || !current(value)) return;
                state.loading = false; state.error = safeServiceError(error).code; emit(); throw safeServiceError(error);
            }
        },
        update(id, patch) {
            const value = requireDraft(), row = slotRow(id);
            if (Object.hasOwn(patch,'modelId') && !value.configuration.allowModelOverride || Object.hasOwn(patch,'reasoning') && !value.configuration.allowReasoningOverride) fail('permission-denied');
            let next = profileValue(patch, row.value);
            if (next.target && row.value.target && targetKey(next.target) !== targetKey(row.value.target)) next = fixedOptions(value.configuration,{ target: next.target, ...nativeDefaults });
            checkTarget(value.configuration, next);
            checkPermission(value.configuration, next);
            const changed = targetKey(next.target!) !== targetKey(row.value.target!);
            row.value = next; row.error = undefined;
            if (changed) { row.catalog = null; void refreshRow(id, value, epoch); } else emit();
        },
        async refresh(id) { const value = requireDraft(); await refreshRow(id, value, epoch); },
        async save() {
            const value = requireDraft(), generation = epoch;
            for (const row of state.rows) validateRow(row, value.configuration);
            const record: ServiceProfilesRecord = { version: 1, slots: Object.fromEntries(state.rows.map(row => [row.id, structuredClone(row.value)])) };
            state.saving = true; state.error = null; emit();
            try {
                await options.write(structuredClone(value.scope), record);
                if (disposed || generation !== epoch || !current(value)) return;
                baseline = structuredClone(state.rows); state.editing = false;
            } catch {
                if (!disposed && generation === epoch && current(value)) state.error = 'storage-unavailable';
                return fail('storage-unavailable');
            } finally { if (!disposed && generation === epoch) { state.saving = false; emit(); } }
        },
        cancel() { open(); if (state.saving) fail('resource-busy'); invalidate(); state.rows = structuredClone(baseline); state.editing = false; state.loading = false; state.error = null; emit(); },
        async getOverrides(id) {
            if (!slots.some(slot => slot.id === id)) return fail('invalid-request');
            const value = capture(), loaded = await load(value), row = loaded.rows.find(row => row.id === id)!;
            checkTarget(loaded.configuration, row.value); checkPermission(loaded.configuration, row.value); const overrides=structuredClone(row.value);
            if(!loaded.configuration.allowModelOverride)delete overrides.modelId;
            if(!loaded.configuration.allowReasoningOverride)delete overrides.reasoning;
            return overrides;
        },
        dispose() { if (disposed) return; disposed = true; invalidate(); listeners.clear(); context = null; baseline = []; state.rows = []; },
    };
}
