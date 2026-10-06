import { expect, it, vi } from 'vitest';
import type { CapabilityCatalog, ServiceConfiguration, ServiceTarget } from '@slopus/happy-wire/ai-services';
import { createServiceProfiles } from './profiles';
import type { ServiceProfilesClient, ServiceProfilesScope } from './profiles';
import type { ServiceConnection } from './types';

const first: ServiceTarget = { machineId: 'first', engine: 'codex', accountRef: { kind: 'codex-profile', id: 'account-a' } };
const second: ServiceTarget = { machineId: 'second', engine: 'codex', accountRef: { kind: 'codex-profile', id: 'account-b' } };
function directory(modelId = 'configured-model'): ServiceConfiguration {
    return { service: { id: 'service', ownerId: 'owner', name: 'AI', enabled: true, revision: 1 },
        allowModelOverride: true, allowReasoningOverride: true, defaults: { ...first, modelId, reasoning: { mode: 'explicit', value: 'high' }, permissionMode: 'read-only', serviceTier: 'fast' },
        targets: [{ target: first, machineName: 'First Mac', accountName: 'Account A' }, { target: second, machineName: 'Second Mac', accountName: 'Account B' }], permissions: ['chat', 'tools'] };
}
function catalog(target: ServiceTarget, defaultModelId = 'configured-model'): CapabilityCatalog {
    return { ...target, protocol: 'ai-services/1', observedAt: Date.now(), availability: 'online', completeness: 'complete', defaultModelId,
        models: ['configured-model', 'other-model'].map(id => ({ id, name: id, supportsImages: false,
            reasoning: { supportsDefault: true, values: ['high', 'low'], defaultValue: 'low' }, serviceTiers: ['default', 'fast'] })),
        execution: { permissionModes: ['chat-only', 'read-only', 'yolo'], serviceTiers: ['default', 'fast'] } };
}
function setup() {
    const saved = new Map<string, unknown>(), writes: { scope: ServiceProfilesScope; value: unknown }[] = [];
    let source: 'platform' | 'personal' = 'platform', connectionId = 'platform-grant';
    let capabilityRead = async ({ target }: { target: ServiceTarget }) => catalog(target);
    let configurationRead = async () => directory();
    const clients: Record<'platform' | 'personal', ServiceProfilesClient> = {
        platform: { source: 'platform', services: { configuration: () => configurationRead() }, capabilities: { read: options => capabilityRead(options) } },
        personal: { source: 'personal', services: { configuration: () => configurationRead() }, capabilities: { read: options => capabilityRead(options) } },
    };
    const scopeKey = (scope: ServiceProfilesScope) => JSON.stringify(scope);
    const profiles = createServiceProfiles({ slots: [{ id: 'reply', name: 'Reply' }, { id: 'summary', name: 'Summary', description: 'Short summary' }],
        client: () => clients[source], connection: (): ServiceConnection => ({ id: connectionId, source, appId: 'advisor', serviceId: 'service', expiresAt: null }),
        read: scope => saved.get(scopeKey(scope)), write: (scope, value) => { writes.push({ scope, value }); saved.set(scopeKey(scope), structuredClone(value)); } });
    return { profiles, writes, saved, setSource(next: typeof source, id: string) { source = next; connectionId = id; },
        capabilities(read: typeof capabilityRead) { capabilityRead = read; }, configuration(read: typeof configurationRead) { configurationRead = read; } };
}

it('loads each slot from service defaults and keeps capability reads scoped to its target', async () => {
    const f = setup(), observed: string[] = [];
    f.capabilities(async ({ target }) => { observed.push(target.machineId); return catalog(target); });
    await f.profiles.begin();
    const state = f.profiles.getState();
    expect(state.rows.map(row => row.value)).toEqual([0, 1].map(() => ({ target: first, modelId: 'configured-model', reasoning: { mode: 'explicit', value: 'high' }, permissionMode: 'read-only', serviceTier: 'fast' })));
    expect(state.rows.every(row => row.catalog?.machineId === 'first' && !row.loading)).toBe(true);
    expect(observed).toEqual(['first']);
    state.rows[0].value.modelId = 'mutated-snapshot';
    expect(f.profiles.getState().rows[0].value.modelId).toBe('configured-model');
    f.profiles.dispose();
});

it('saves all slot drafts once and never exposes unsaved edits to new conversations', async () => {
    const f = setup();
    await f.profiles.begin();
    f.profiles.update('reply', { modelId: 'other-model', reasoning: { mode: 'explicit', value: 'low' } });
    expect((await f.profiles.getOverrides('reply')).modelId).toBe('configured-model');
    await f.profiles.save();
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].scope).toEqual({ source: 'platform', serviceId: 'service', connectionId: 'platform-grant' });
    expect((await f.profiles.getOverrides('reply')).modelId).toBe('other-model');
    expect((await f.profiles.getOverrides('summary')).modelId).toBe('configured-model');
    await f.profiles.begin();
    f.profiles.update('reply', { modelId: 'configured-model' });
    f.profiles.cancel();
    expect(f.profiles.getState().rows[0].value.modelId).toBe('other-model');
    expect((await f.profiles.getOverrides('reply')).modelId).toBe('other-model');
    expect(f.writes).toHaveLength(1);
    f.profiles.dispose();
});

it('isolates platform, personal and replacement grants even when the service id matches', async () => {
    const f = setup();
    await f.profiles.begin(); f.profiles.update('reply', { modelId: 'other-model' }); await f.profiles.save();
    f.setSource('personal', 'personal-grant');
    expect((await f.profiles.getOverrides('reply')).modelId).toBe('configured-model');
    await f.profiles.begin(); f.profiles.update('summary', { reasoning: { mode: 'explicit', value: 'low' } }); await f.profiles.save();
    f.setSource('personal', 'replacement-grant');
    expect((await f.profiles.getOverrides('summary')).reasoning).toEqual({ mode: 'explicit', value: 'high' });
    f.setSource('platform', 'platform-grant');
    expect((await f.profiles.getOverrides('reply')).modelId).toBe('other-model');
    expect((await f.profiles.getOverrides('summary')).reasoning).toEqual({ mode: 'explicit', value: 'high' });
    f.profiles.dispose();
});

it('clears dependent options on target change and ignores a stale capability response', async () => {
    const f = setup(); await f.profiles.begin();
    let release!: (value: CapabilityCatalog) => void;
    f.capabilities(async ({ target }) => target.machineId === 'first' ? new Promise(resolve => { release = resolve; }) : catalog(target, 'other-model'));
    const oldRefresh = f.profiles.refresh('reply');
    await vi.waitFor(() => expect(release).toBeDefined());
    f.profiles.update('reply', { target: second });
    await vi.waitFor(() => expect(f.profiles.getState().rows[0].catalog?.machineId).toBe('second'));
    release(catalog(first)); await oldRefresh;
    expect(f.profiles.getState().rows[0]).toMatchObject({ catalog: { machineId: 'second' }, value: { target: second, modelId: null, reasoning: { mode: 'default' }, permissionMode: 'chat-only', serviceTier: 'default' } });
    expect(f.profiles.getState().rows[1].value.target).toEqual(first);
    f.profiles.dispose();
});

it('does not let a cancelled refresh overwrite the restored rows', async () => {
    const f = setup(); await f.profiles.begin();
    let release!: (value: CapabilityCatalog) => void;
    f.capabilities(async () => new Promise(resolve => { release = resolve; }));
    const pending = f.profiles.refresh('reply');
    await vi.waitFor(() => expect(release).toBeDefined());
    f.profiles.update('reply', { modelId: 'other-model' }); f.profiles.cancel();
    release(catalog(first, 'other-model')); await pending;
    expect(f.profiles.getState()).toMatchObject({ editing: false, rows: [{ value: { modelId: 'configured-model' }, catalog: { defaultModelId: 'configured-model' } }, {}] });
    f.profiles.dispose();
});

it('rejects a target outside the directory and credential fields without persisting them', async () => {
    const f = setup(); await f.profiles.begin();
    expect(() => f.profiles.update('reply', { target: { ...first, machineId: 'foreign' } })).toThrow('permission-denied');
    expect(() => f.profiles.update('reply', { token: 'must-not-save' } as never)).toThrow('invalid-request');
    expect(f.writes).toHaveLength(0);
    f.profiles.dispose();
});

it('loads saved settings for new conversations without querying capabilities', async () => {
    const f = setup(); f.capabilities(async () => { throw Error('must not probe'); });
    expect(await f.profiles.getOverrides('reply')).toMatchObject({ target: first, modelId: 'configured-model' });
    f.profiles.dispose();
});

it('keeps drafts open when the atomic persistence write fails', async () => {
    const f = setup(); await f.profiles.begin();
    f.profiles.update('reply', { modelId: 'other-model' });
    const failure = vi.spyOn(f.saved, 'set').mockImplementation(() => { throw Error('disk full'); });
    await expect(f.profiles.save()).rejects.toMatchObject({ code: 'storage-unavailable' });
    expect(f.profiles.getState()).toMatchObject({ editing: true, saving: false, rows: [{ value: { modelId: 'other-model' } }, {}] });
    expect((await f.profiles.getOverrides('reply')).modelId).toBe('configured-model');
    failure.mockRestore(); f.profiles.dispose();
});

it('filters tool modes by the grant and still lets a user repair an unavailable saved mode', async () => {
    const f = setup();
    f.configuration(async () => ({ ...directory(), permissions: ['chat'] }));
    await f.profiles.begin();
    expect(f.profiles.getState().rows[0].catalog?.execution?.permissionModes).toEqual(['chat-only']);
    expect(() => f.profiles.update('reply', { permissionMode: 'yolo' })).toThrow('permission-denied');
    f.profiles.update('reply', { permissionMode: 'chat-only' });
    f.profiles.update('summary', { permissionMode: 'chat-only' });
    await f.profiles.save();
    expect((await f.profiles.getOverrides('reply')).permissionMode).toBe('chat-only');
    f.profiles.dispose();
});

it('ignores an old source directory response after beginning another source', async () => {
    const f = setup();
    let release!: (value: ServiceConfiguration) => void;
    f.configuration(async () => new Promise(resolve => { release = resolve; }));
    const old = f.profiles.begin();
    await vi.waitFor(() => expect(release).toBeDefined());
    f.setSource('personal', 'personal-grant'); f.configuration(async () => directory('other-model'));
    await f.profiles.begin();
    release(directory()); await old;
    expect(f.profiles.getState()).toMatchObject({ source: 'personal', connectionId: 'personal-grant', rows: [{ value: { modelId: 'other-model' } }, { value: { modelId: 'other-model' } }] });
    f.profiles.dispose();
});

it('rejects unavailable model settings before writing any slot', async () => {
    const f = setup(); await f.profiles.begin();
    f.profiles.update('reply', { modelId: 'missing-model' });
    await expect(f.profiles.save()).rejects.toMatchObject({ code: 'model-unavailable' });
    expect(f.writes).toHaveLength(0);
    f.profiles.dispose();
});

it('keeps fixed model and reasoning grants usable without sending forbidden overrides', async () => {
 const f=setup(); f.configuration(async()=>({...directory(),allowModelOverride:false,allowReasoningOverride:false}));
 await f.profiles.begin();
 expect(f.profiles.getState().rows[0].allowModelOverride).toBe(false);
 expect(()=>f.profiles.update('reply',{modelId:'other-model'})).toThrowError(expect.objectContaining({code:'permission-denied'}));
 f.profiles.update('reply',{target:second});
 expect(f.profiles.getState().rows[0].value.modelId).toBe('configured-model');
 expect(f.profiles.getState().rows[0].value.reasoning).toEqual({mode:'explicit',value:'high'});
 const overrides=await f.profiles.getOverrides('reply');
 expect(overrides).not.toHaveProperty('modelId');expect(overrides).not.toHaveProperty('reasoning');
 f.profiles.dispose();
});
