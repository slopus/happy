import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CapabilityCatalog, ServiceConfig, ServicePrincipal } from '@slopus/happy-wire';
import { createAIServiceStore } from './store';
import { createTestDatabase } from './testDatabase';
import { authorizeProbe } from './authority';

const appId = 'relationship-advisor';
describe('AI service persistence and authorization', () => {
    let context: Awaited<ReturnType<typeof createTestDatabase>>;
    let store: ReturnType<typeof createAIServiceStore>;
    let owner: string, other: string, machine: string, profile: string;
    let config: Extract<ServiceConfig, { engine: 'codex' }>;
    let catalog: CapabilityCatalog | null;
    let sequence = 0;
    const principal = (): ServicePrincipal => ({ kind: 'owner', ownerId: owner });
    const create = () => store.createService(owner, { name: 'My service', config });
    beforeAll(async () => { context = await createTestDatabase(); }, 120000);
    beforeEach(async () => {
        owner = `service-owner-${++sequence}`; other = `${owner}-other`; machine = `${owner}-machine`; profile = `${owner}-profile`;
        for (const id of [owner, other]) await context.database.account.create({ data: { id, publicKey: id } });
        await context.database.machine.create({ data: { id: machine, accountId: owner, metadata: 'encrypted' } });
        await context.database.codexAccountProfile.create({ data: { id: profile, accountId: owner, displayName: 'Work', externalAccountFingerprint: 'identity-A', credential: Buffer.from('auth-secret') } });
        config = { machineId: machine, engine: 'codex', accountRef: { kind: 'codex-profile', id: profile }, modelId: null, reasoning: { mode: 'default' } };
        catalog = { protocol: 'ai-services/1', machineId: machine, engine: 'codex', accountRef: { kind: 'codex-profile', id: profile }, observedAt: Date.now(), availability: 'online', completeness: 'complete', defaultModelId: 'native-default', models: [
            { id: 'native-default', name: 'Default', supportsImages: true, reasoning: { supportsDefault: true, values: ['native-high'], defaultValue: 'native-high' } },
            { id: 'native-text', name: 'Text', supportsImages: false, reasoning: { supportsDefault: true, values: [], defaultValue: null } },
        ] };
        store = createAIServiceStore(context.database, { readLive: async () => catalog });
    });
    afterAll(async () => { await context?.database.$disconnect(); await context?.pg.close(); });

    it('selects an approved target and retains its authorized account identity', async () => {
        const second = { machineId: machine, engine: 'codex' as const, accountRef: { kind: 'codex-profile' as const, id: profile + '-second' } };
        await context.database.codexAccountProfile.create({ data: { id: second.accountRef.id, accountId: owner, displayName: 'Second', externalAccountFingerprint: 'identity-B', credential: Buffer.from('unused') } });
        store = createAIServiceStore(context.database, { readLive: async (_owner, target) => ({ ...catalog!, ...target, observedAt: Date.now() }) });
        const service = await create();
        const grant = await store.registerAuthorization(owner, { id: owner + '-targets', kind: 'personal-grant', scope: { appId, serviceId: service.id, targets: [{ machineId: machine, engine: 'codex', accountRef: config.accountRef }, second], permissions: ['chat'], expiresAt: null }, allowModelOverride: true, allowReasoningOverride: true });
        const user: ServicePrincipal = { kind: 'personal-grant', ownerId: owner, grantId: grant.id, scope: grant.scope };
        const chosen = await store.resolveBinding(user, appId, service.id, { target: second } as any);
        expect(chosen.accountRef).toEqual(second.accountRef);
        await context.database.codexAccountProfile.update({ where: { id: second.accountRef.id }, data: { externalAccountFingerprint: 'replaced-B' } });
        await expect(store.resolveBinding(user, appId, service.id, { target: second } as any)).rejects.toMatchObject({ code: 'account-identity-changed' });
        await expect(store.resolveBinding(user, appId, service.id, { target: { ...second, machineId: 'foreign' } } as any)).rejects.toMatchObject({ code: 'consent-required' });
    });

    it('requires tools authorization and advertised Fast support for an execution preset', async () => {
        const app = await context.database.aIServiceApplication.findUniqueOrThrow({ where: { appId } });
        await context.database.aIServiceApplication.update({ where: { appId }, data: { policy: { ...(app.policy as object), capabilities: ['chat', 'images', 'tools'] } } });
        catalog = { ...catalog!, execution: { permissionModes: ['chat-only', 'yolo'], serviceTiers: ['default', 'fast'] }, models: catalog!.models.map(model => ({ ...model, serviceTiers: ['default', 'fast'] })) } as CapabilityCatalog;
        const service = await create();
        const scope = { appId, serviceId: service.id, targets: [{ machineId: machine, engine: 'codex' as const, accountRef: config.accountRef }], permissions: ['chat', 'tools'] as ('chat'|'tools')[], expiresAt: null };
        const grant = await store.registerAuthorization(owner, { id: owner + '-tools', kind: 'platform-grant', scope, allowModelOverride: true, allowReasoningOverride: true });
        const user: ServicePrincipal = { kind: 'platform-grant', ownerId: owner, grantId: grant.id, scope: grant.scope };
        const options = { permissionMode: 'yolo', serviceTier: 'fast' } as const;
        const binding = await store.resolveBinding(user, appId, service.id, options);
        expect(binding).toMatchObject(options);
        const narrow = await store.registerAuthorization(owner, { id: owner + '-text', kind: 'platform-grant', scope: { ...scope, permissions: ['chat'] }, allowModelOverride: true, allowReasoningOverride: true });
        await expect(store.resolveBinding({ ...user, grantId: narrow.id, scope: narrow.scope }, appId, service.id, options as any)).rejects.toMatchObject({ code: 'permission-denied' });
        catalog = { ...catalog!, models: catalog!.models.map(model => ({ ...model, serviceTiers: ['default'] })) };
        await expect(store.resolveBinding(user, appId, service.id, options as any)).rejects.toMatchObject({ code: 'parameter-unsupported' });
        await expect(store.validateBinding(user, appId, binding.id)).rejects.toMatchObject({ code: 'parameter-unsupported' });
    });

    it('checks the original approved account fingerprint before authorizing capability discovery', async () => {
        const second = { machineId: machine, engine: 'codex' as const, accountRef: { kind: 'codex-profile' as const, id: profile + '-probe' } };
        await context.database.codexAccountProfile.create({ data: { id: second.accountRef.id, accountId: owner, displayName: 'Probe account', externalAccountFingerprint: 'probe-original', credential: Buffer.from('unused') } });
        const service = await create();
        const grant = await store.registerAuthorization(owner, { id: owner + '-probe-auth', kind: 'personal-grant', scope: { appId, serviceId: service.id, targets: [{ machineId: machine, engine: 'codex', accountRef: config.accountRef }, second], permissions: ['chat'], expiresAt: null }, allowModelOverride: true, allowReasoningOverride: true });
        const user: ServicePrincipal = { kind: 'personal-grant', ownerId: owner, grantId: grant.id, scope: grant.scope };
        await context.database.codexAccountProfile.update({ where: { id: second.accountRef.id }, data: { externalAccountFingerprint: 'probe-replaced' } });
        await expect(context.database.$transaction(tx => authorizeProbe(tx, user, second))).rejects.toMatchObject({ code: 'account-identity-changed' });
        await expect(store.updateAuthorizationScope(owner, grant.id, { scope: grant.scope, allowModelOverride: true, allowReasoningOverride: true })).rejects.toMatchObject({ code: 'account-identity-changed' });
    });

    it('resets incompatible model and reasoning defaults when an approved engine changes', async () => {
        const claude = { machineId: machine, engine: 'claude' as const, accountRef: { kind: 'device-identity' as const, machineId: machine, identityId: 'claude-test' } };
        const codexCatalog = catalog!;
        store = createAIServiceStore(context.database, { readLive: async (_owner, target) => target.engine === 'codex' ? { ...codexCatalog, observedAt: Date.now() } : {
            ...claude, protocol: 'ai-services/1', observedAt: Date.now(), availability: 'online', completeness: 'limited', defaultModelId: 'sonnet',
            models: [{ id: 'sonnet', name: 'Sonnet', supportsImages: false, reasoning: { supportsDefault: true, values: [], defaultValue: null } }],
        } });
        const service = await store.createService(owner, { name: 'Different engines', config: { ...config, modelId: 'native-default', reasoning: { mode: 'explicit', value: 'native-high' } } });
        const grant = await store.registerAuthorization(owner, { id: owner + '-engines', kind: 'personal-grant', scope: { appId, serviceId: service.id, targets: [{ machineId: machine, engine: 'codex', accountRef: config.accountRef }, claude], permissions: ['chat', 'images'], expiresAt: null }, allowModelOverride: true, allowReasoningOverride: true });
        const user: ServicePrincipal = { kind: 'personal-grant', ownerId: owner, grantId: grant.id, scope: grant.scope };
        expect(await store.resolveBinding(user, appId, service.id, { target: claude })).toMatchObject({ engine: 'claude', requestedModel: null, reasoning: { mode: 'default' }, permissions: ['chat'] });
        await expect(store.resolveBinding(user, appId, service.id, { target: claude, permissions: ['chat', 'images'] })).rejects.toMatchObject({ code: 'parameter-unsupported' });
    });

    it('derives implicit permissions from the selected text model and chat-only mode without weakening explicit requests', async () => {
        const app = await context.database.aIServiceApplication.findUniqueOrThrow({ where: { appId } });
        await context.database.aIServiceApplication.update({ where: { appId }, data: { policy: { ...(app.policy as object), capabilities: ['chat', 'images', 'tools'] } } });
        const service = await create();
        const grant = await store.registerAuthorization(owner, { id: owner + '-implicit', kind: 'personal-grant', scope: { appId, serviceId: service.id, targets: [{ machineId: machine, engine: 'codex', accountRef: config.accountRef }], permissions: ['chat', 'images', 'tools'], expiresAt: null }, allowModelOverride: true, allowReasoningOverride: true });
        const user: ServicePrincipal = { kind: 'personal-grant', ownerId: owner, grantId: grant.id, scope: grant.scope };
        expect(await store.resolveBinding(user, appId, service.id, { modelId: 'native-text' })).toMatchObject({ permissions: ['chat'] });
        await expect(store.resolveBinding(user, appId, service.id, { modelId: 'native-text', permissions: ['chat', 'images'] })).rejects.toMatchObject({ code: 'parameter-unsupported' });
        expect(await store.resolveBinding(user, appId, service.id, { modelId: 'native-default' })).toMatchObject({ permissions: ['chat', 'images'] });
    });

    it('keeps legacy grants on their default target and filters invalid extra directory targets', async () => {
        const second = { machineId: machine, engine: 'codex' as const, accountRef: { kind: 'codex-profile' as const, id: profile + '-legacy' } };
        await context.database.codexAccountProfile.create({ data: { id: second.accountRef.id, accountId: owner, displayName: 'Legacy extra', externalAccountFingerprint: 'legacy-extra', credential: Buffer.from('unused') } });
        const service = await create();
        const grant = await store.registerAuthorization(owner, { id: owner + '-legacy-targets', kind: 'personal-grant', scope: { appId, serviceId: service.id, targets: [{ machineId: machine, engine: 'codex', accountRef: config.accountRef }, second], permissions: ['chat'], expiresAt: null }, allowModelOverride: true, allowReasoningOverride: true });
        const user: ServicePrincipal = { kind: 'personal-grant', ownerId: owner, grantId: grant.id, scope: grant.scope };
        expect((await store.readConfiguration(user)).targets).toHaveLength(2);
        await context.database.codexAccountProfile.update({ where: { id: profile }, data: { externalAccountFingerprint: 'temporarily-unavailable-default' } });
        const directory = await store.readConfiguration(user);
        expect(directory.defaults).toEqual(config);
        expect(directory.targets.map(item => item.target)).toEqual([second]);
        await context.database.codexAccountProfile.update({ where: { id: profile }, data: { externalAccountFingerprint: 'identity-A' } });
        await context.database.codexAccountProfile.update({ where: { id: second.accountRef.id }, data: { externalAccountFingerprint: 'changed-extra' } });
        expect((await store.readConfiguration(user)).targets.map(item => item.target.accountRef)).toEqual([config.accountRef]);
        await context.database.$executeRaw`UPDATE "AIServiceAuthorization" SET "targetFingerprints" = NULL WHERE "id" = ${grant.id}`;
        expect(await store.resolveBinding(user, appId, service.id, {})).toMatchObject({ accountRef: config.accountRef });
        await expect(store.resolveBinding(user, appId, service.id, { target: second })).rejects.toMatchObject({ code: 'consent-required' });
        await expect(context.database.$transaction(tx => authorizeProbe(tx, user, second))).rejects.toMatchObject({ code: 'consent-required' });
        await context.database.codexAccountProfile.update({ where: { id: profile }, data: { externalAccountFingerprint: 'changed-default' } });
        await expect(store.readConfiguration(user)).rejects.toMatchObject({ code: 'account-identity-changed' });
    });

    it('persists one grant-scoped application conversation through concurrent creates and a lost response', async () => {
        const service=await create();
        const grant=await store.registerAuthorization(owner,{id:`${owner}-creation`,kind:'personal-grant',scope:{appId,serviceId:service.id,targets:[{machineId:machine,engine:'codex',accountRef:config.accountRef}],permissions:['chat'],expiresAt:null},allowModelOverride:true,allowReasoningOverride:true});
        const user:ServicePrincipal={kind:'personal-grant',ownerId:owner,grantId:grant.id,scope:grant.scope};
        const calls=await Promise.all([1,2].map(()=>store.resolveBinding(user,appId,service.id,{},'app-conversation')));
        expect(calls[0].id).toBe(calls[1].id);
        expect(await context.database.aIServiceBinding.count({where:{serviceId:service.id}})).toBe(1);
        // The accepted response is deliberately discarded. Recovery cannot observe a new default.
        await store.updateService(owner,service.id,1,{...config,modelId:'native-text'});
        const offline=createAIServiceStore(context.database,{readLive:async()=>{throw new Error('Recovery must not probe');}});
        expect(await offline.resolveBinding(user,appId,service.id,{},'app-conversation')).toEqual(calls[0]);
        expect(await offline.findApplicationBinding(user,appId,'app-conversation')).toEqual(calls[0]);
        await expect(offline.resolveBinding(user,appId,service.id,{modelId:'native-text'},'app-conversation')).rejects.toMatchObject({code:'invalid-request'});
        const otherGrant=await store.registerAuthorization(owner,{id:`${owner}-foreign-creation`,kind:'personal-grant',scope:grant.scope,allowModelOverride:false,allowReasoningOverride:false});
        expect(await offline.findApplicationBinding({...user,grantId:otherGrant.id},appId,'app-conversation')).toBeNull();
        await store.revokeAuthorization(owner,grant.id);
        await expect(offline.findApplicationBinding(user,appId,'app-conversation')).rejects.toMatchObject({code:'authorization-revoked'});
        await expect(offline.resolveBinding(user,appId,service.id,{},'app-conversation')).rejects.toMatchObject({code:'authorization-revoked'});
    });

    it('allows a live daemon probe to save refreshed credentials without holding DB locks', async () => {
        const service = await create();
        const callbackStore = createAIServiceStore(context.database, { readLive: async () => {
            await context.database.$transaction(async tx => {
                await tx.codexAccountProfile.update({ where: { id: profile }, data: { credentialVersion: { increment: 1 } } });
            });
            return catalog;
        } });
        const binding = await callbackStore.resolveBinding(principal(), appId, service.id, {});
        expect(binding.accountRef).toEqual(config.accountRef);
        expect((await context.database.codexAccountProfile.findUniqueOrThrow({ where: { id: profile } })).credentialVersion).toBe(2);
    }, 10000);

    it.each(['revoke', 'identity', 'default'] as const)('revalidates %s changes made during a DB-callback probe', async change => {
        const service = await create();
        const grant = await store.registerAuthorization(owner, { id: `${owner}-race`, kind: 'personal-grant', scope: { appId, serviceId: service.id, targets: [ { machineId: machine, engine: 'codex', accountRef: config.accountRef } ], permissions: ['chat'], expiresAt: null }, allowModelOverride: true, allowReasoningOverride: true });
        const user: ServicePrincipal = { kind: 'personal-grant', ownerId: owner, grantId: grant.id, scope: grant.scope };
        let changed = false;
        const racing = createAIServiceStore(context.database, { readLive: async () => {
            if (!changed) {
                changed = true;
                if (change === 'revoke') await store.revokeAuthorization(owner, grant.id);
                if (change === 'identity') await context.database.codexAccountProfile.update({ where: { id: profile }, data: { externalAccountFingerprint: 'replaced' } });
                if (change === 'default') await store.updateService(owner, service.id, 1, { ...config, modelId: 'native-text' });
            }
            return catalog;
        } });
        if (change === 'default') expect(await racing.resolveBinding(user, appId, service.id, {})).toMatchObject({ revision: 2, requestedModel: 'native-text' });
        else {
            await expect(racing.resolveBinding(user, appId, service.id, {})).rejects.toMatchObject({ code: change === 'revoke' ? 'authorization-revoked' : 'account-identity-changed' });
            expect(await context.database.aIServiceBinding.count({ where: { serviceId: service.id } })).toBe(0);
        }
    });

    it('commits one concurrent revision update and preserves revision history', async () => {
        const service = await create();
        const results = await Promise.allSettled(['native-default', 'native-text'].map(modelId => store.updateService(owner, service.id, 1, { ...config, modelId })));
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'revision-conflict' } });
        expect((await store.readService(owner, service.id)).service.revision).toBe(2);
        expect(await context.database.aIServiceRevision.count({ where: { serviceId: service.id } })).toBe(2);
        expect((await store.readRevision(owner, service.id, 1)).config.modelId).toBeNull();
    });
    it('blocks foreign reads, writes, accounts and machines', async () => {
        const service = await create();
        expect(await store.listServices(other)).toEqual([]);
        await expect(store.readService(other, service.id)).rejects.toMatchObject({ code: 'service-not-found' });
        await expect(store.updateService(other, service.id, 1, config)).rejects.toMatchObject({ code: 'service-not-found' });
        await expect(store.createService(other, { name: 'Foreign', config })).rejects.toMatchObject({ code: 'permission-denied' });
        await context.database.machine.create({ data: { id: 'foreign-machine', accountId: other, metadata: 'encrypted' } });
        await expect(store.createService(owner, { name: 'Foreign', config: { ...config, machineId: 'foreign-machine' } })).rejects.toMatchObject({ code: 'permission-denied' });
        await context.database.codexAccountProfile.create({ data: { id: `${owner}-foreign-profile`, accountId: other, displayName: 'Foreign', externalAccountFingerprint: 'foreign-identity', credential: Buffer.from('foreign-secret') } });
        await expect(store.createService(owner, { name: 'Foreign profile', config: { ...config, accountRef: { kind: 'codex-profile', id: `${owner}-foreign-profile` } } })).rejects.toMatchObject({ code: 'account-not-found' });
    });
    it('binds one complete revision during a default update and never rewrites existing bindings', async () => {
        const service = await create();
        const first = await store.resolveBinding(principal(), appId, service.id, {});
        const [, binding] = await Promise.all([
            store.updateService(owner, service.id, 1, { ...config, modelId: 'native-default', reasoning: { mode: 'explicit', value: 'native-high' } }),
            store.resolveBinding(principal(), appId, service.id, {}),
        ]);
        expect([1, 2]).toContain(binding.revision);
        expect(binding.requestedModel).toBe(binding.revision === 1 ? null : 'native-default');
        expect(binding.reasoning).toEqual(binding.revision === 1 ? { mode: 'default' } : { mode: 'explicit', value: 'native-high' });
        expect(await store.readBinding(principal(), appId, first.id)).toEqual(first);
        await expect(store.readBinding(principal(), 'unknown-app', first.id)).rejects.toMatchObject({ code: 'permission-denied' });
        await expect(context.database.aIServiceBinding.update({ where: { id: first.id }, data: { snapshot: { changed: true } } })).rejects.toThrow();
        await expect(context.database.aIServiceRevision.delete({ where: { serviceId_revision: { serviceId: service.id, revision: 1 } } })).rejects.toThrow();
    });
    it('uses stored authorization tuples and denies scope widening, override escalation and cross-app reads', async () => {
        const service = await create();
        const grant = await store.registerAuthorization(owner, { id: `${owner}-grant`, kind: 'personal-grant', scope: { appId, serviceId: service.id, targets: [{ machineId: machine, engine: 'codex', accountRef: { kind: 'codex-profile', id: profile } }], permissions: ['chat'], expiresAt: null }, allowModelOverride: false, allowReasoningOverride: false });
        const user: ServicePrincipal = { kind: 'personal-grant', ownerId: owner, grantId: grant.id, scope: grant.scope };
        const binding = await store.resolveBinding(user, appId, service.id, {});
        await expect(store.resolveBinding(user, appId, service.id, { modelId: 'native-default' })).rejects.toMatchObject({ code: 'permission-denied' });
        await expect(store.resolveBinding({ ...user, scope: { ...user.scope, permissions: ['chat', 'images'] } }, appId, service.id, {})).rejects.toMatchObject({ code: 'permission-denied' });
        const otherApp = `${owner}-app`;
        await store.registerApplication({ appId: otherApp, name: 'Other application', origins: ['https://other.example'], capabilities: ['chat'], businessPrompt: { id: 'other', version: '1' } });
        await expect(store.resolveBinding(user, otherApp, service.id, {})).rejects.toMatchObject({ code: 'permission-denied' });
        await expect(store.readBinding(user, otherApp, binding.id)).rejects.toMatchObject({ code: 'permission-denied' });
        const second = await store.registerAuthorization(owner, { id: `${owner}-second`, kind: 'personal-grant', scope: grant.scope, allowModelOverride: true, allowReasoningOverride: true });
        await expect(store.readBinding({ ...user, grantId: second.id }, appId, binding.id)).rejects.toMatchObject({ code: 'permission-denied' });
        await store.revokeAuthorization(owner, grant.id);
        await expect(store.readBinding(user, appId, binding.id)).rejects.toMatchObject({ code: 'authorization-revoked' });
    });
    it('rejects a new default target outside the exact approved tuple', async () => {
        const service = await create();
        const grant = await store.registerAuthorization(owner, { id: `${owner}-grant`, kind: 'platform-grant', scope: { appId, serviceId: service.id, targets: [{ machineId: machine, engine: 'codex', accountRef: { kind: 'codex-profile', id: profile } }], permissions: ['chat'], expiresAt: null }, allowModelOverride: true, allowReasoningOverride: true });
        await context.database.machine.create({ data: { id: `${machine}-two`, accountId: owner, metadata: 'encrypted' } });
        await store.updateService(owner, service.id, 1, { ...config, machineId: `${machine}-two` });
        await expect(store.resolveBinding({ kind: 'platform-grant', ownerId: owner, grantId: grant.id, scope: grant.scope }, appId, service.id, {})).rejects.toMatchObject({ code: 'consent-required' });
    });
    it('rejects Cartesian target combinations and expired authorizations', async () => {
        const service = await create();
        const secondMachine = `${machine}-second`, secondProfile = `${profile}-second`;
        await context.database.machine.create({ data: { id: secondMachine, accountId: owner, metadata: 'encrypted' } });
        await context.database.codexAccountProfile.create({ data: { id: secondProfile, accountId: owner, displayName: 'Second', externalAccountFingerprint: 'identity-B', credential: Buffer.from('second-secret') } });
        const grant = await store.registerAuthorization(owner, { id: `${owner}-grant`, kind: 'personal-grant', scope: { appId, serviceId: service.id, targets: [
            { machineId: machine, engine: 'codex', accountRef: { kind: 'codex-profile', id: profile } },
            { machineId: secondMachine, engine: 'codex', accountRef: { kind: 'codex-profile', id: secondProfile } },
        ], permissions: ['chat'], expiresAt: null }, allowModelOverride: true, allowReasoningOverride: true });
        const user: ServicePrincipal = { kind: 'personal-grant', ownerId: owner, grantId: grant.id, scope: grant.scope };
        const binding = await store.resolveBinding(user, appId, service.id, {});
        await store.updateService(owner, service.id, 1, { ...config, accountRef: { kind: 'codex-profile', id: secondProfile } });
        await expect(store.resolveBinding(user, appId, service.id, {})).rejects.toMatchObject({ code: 'consent-required' });
        expect(await store.validateBinding(user, appId, binding.id)).toEqual(binding);
        await context.database.aIServiceAuthorization.update({ where: { id: grant.id }, data: { expiresAt: new Date(0) } });
        await expect(store.validateBinding(user, appId, binding.id)).rejects.toMatchObject({ code: 'authorization-expired' });
    });
    it('keeps identity after credential refresh but blocks deleted or replaced accounts', async () => {
        const service = await create(); const binding = await store.resolveBinding(principal(), appId, service.id, {});
        await context.database.codexAccountProfile.update({ where: { id: profile }, data: { credentialVersion: 2, credential: Buffer.from('new-auth-secret') } });
        expect(await store.validateBinding(principal(), appId, binding.id)).toEqual(binding);
        await context.database.codexAccountProfile.delete({ where: { id: profile } });
        await expect(store.resolveBinding(principal(), appId, service.id, {})).rejects.toMatchObject({ code: 'account-not-found' });
        await expect(store.validateBinding(principal(), appId, binding.id)).rejects.toMatchObject({ code: 'account-not-found' });
        await context.database.codexAccountProfile.create({ data: { id: profile, accountId: owner, displayName: 'Replacement', externalAccountFingerprint: 'identity-B', credential: Buffer.from('replacement-secret') } });
        await expect(store.resolveBinding(principal(), appId, service.id, {})).rejects.toMatchObject({ code: 'account-identity-changed' });
        const rows = await context.pg.query('SELECT * FROM "AIServiceRevision" UNION ALL SELECT * FROM "AIServiceRevision" WHERE false');
        expect(JSON.stringify(rows)).not.toContain('auth-secret');
    });
    it.each(['missing', 'stale', 'offline', 'wrong-target', 'malformed'])('fails closed for %s capability observations', async reason => {
        const service = await create();
        if (reason === 'missing') catalog = null;
        if (reason === 'stale') catalog!.observedAt = 0;
        if (reason === 'offline') catalog!.availability = 'offline';
        if (reason === 'wrong-target') catalog!.machineId = 'wrong-machine';
        if (reason === 'malformed') (catalog as any).secret = 'forbidden';
        await expect(store.resolveBinding(principal(), appId, service.id, { modelId: 'native-default' })).rejects.toBeDefined();
        expect(await context.database.aIServiceBinding.count({ where: { serviceId: service.id } })).toBe(0);
    });
    it('validates native models, reasoning and images without substituting runtime defaults', async () => {
        const service = await create();
        await expect(store.resolveBinding(principal(), appId, service.id, { modelId: 'unknown' })).rejects.toMatchObject({ code: 'model-unavailable' });
        await expect(store.resolveBinding(principal(), appId, service.id, { reasoning: { mode: 'explicit', value: 'invented' } })).rejects.toMatchObject({ code: 'parameter-unsupported' });
        await expect(store.resolveBinding(principal(), appId, service.id, { modelId: 'native-text', permissions: ['chat', 'images'] })).rejects.toMatchObject({ code: 'parameter-unsupported' });
        const binding = await store.resolveBinding(principal(), appId, service.id, {});
        expect(binding.requestedModel).toBeNull();
        const cached = await context.database.aIServiceCapabilitySnapshot.findFirstOrThrow({ where: { ownerId: owner } });
        expect(cached.observedAt.getTime()).toBe(catalog!.observedAt);
    });
    it('requires a trusted device identity for Claude configuration', async () => {
        const claude: ServiceConfig = { engine: 'claude', machineId: machine, accountRef: { kind: 'device-identity', machineId: machine, identityId: 'invented-identity' }, modelId: null, reasoning: { mode: 'default' } };
        catalog = null;
        await expect(store.createService(owner, { name: 'Claude', config: claude })).rejects.toMatchObject({ code: 'account-not-found' });
        catalog = { protocol: 'ai-services/1', engine: 'claude', machineId: machine, accountRef: claude.accountRef, observedAt: Date.now(), availability: 'online', completeness: 'complete', defaultModelId: 'claude-native', models: [{ id: 'claude-native', name: 'Claude', supportsImages: true, reasoning: { supportsDefault: true, values: [], defaultValue: null } }] };
        const service = await store.createService(owner, { name: 'Claude', config: claude });
        expect((await store.resolveBinding(principal(), appId, service.id, {})).engine).toBe('claude');
    });
    it.each(['owner', 'allowed-grant', 'denied-grant'] as const)('validates a replacement model over an obsolete default for %s', async caller => {
        const service = await store.createService(owner, { name: 'Explicit default', config: { ...config, modelId: 'native-default' } });
        let user = principal();
        if (caller !== 'owner') {
            const grant = await store.registerAuthorization(owner, { id: `${owner}-grant`, kind: 'platform-grant', scope: { appId, serviceId: service.id, targets: [{ machineId: machine, engine: 'codex', accountRef: { kind: 'codex-profile', id: profile } }], permissions: ['chat'], expiresAt: null }, allowModelOverride: caller === 'allowed-grant', allowReasoningOverride: false });
            user = { kind: 'platform-grant', ownerId: owner, grantId: grant.id, scope: grant.scope };
        }
        catalog!.models = catalog!.models.filter(model => model.id === 'native-text');
        catalog!.defaultModelId = 'native-text';
        if (caller === 'denied-grant') {
            await expect(store.resolveBinding(user, appId, service.id, { modelId: 'native-text' })).rejects.toMatchObject({ code: 'permission-denied' });
            expect(await context.database.aIServiceBinding.count({ where: { serviceId: service.id } })).toBe(0);
        } else {
            const binding = await store.resolveBinding(user, appId, service.id, { modelId: 'native-text' });
            expect(binding).toMatchObject({ revision: 1, requestedModel: 'native-text', reasoning: { mode: 'default' } });
            expect(await store.validateBinding(user, appId, binding.id)).toEqual(binding);
        }
        expect((await store.readRevision(owner, service.id, 1)).config.modelId).toBe('native-default');
        expect((await store.readService(owner, service.id)).service.revision).toBe(1);
    });
    it.each(['owner', 'allowed-grant', 'denied-grant'] as const)('validates replacement reasoning over an obsolete default for %s', async caller => {
        const service = await store.createService(owner, { name: 'Explicit reasoning', config: { ...config, reasoning: { mode: 'explicit', value: 'native-high' } } });
        let user = principal();
        if (caller !== 'owner') {
            const grant = await store.registerAuthorization(owner, { id: `${owner}-grant`, kind: 'personal-grant', scope: { appId, serviceId: service.id, targets: [{ machineId: machine, engine: 'codex', accountRef: { kind: 'codex-profile', id: profile } }], permissions: ['chat'], expiresAt: null }, allowModelOverride: false, allowReasoningOverride: caller === 'allowed-grant' });
            user = { kind: 'personal-grant', ownerId: owner, grantId: grant.id, scope: grant.scope };
        }
        catalog!.models[0].reasoning = { supportsDefault: true, values: ['native-low'], defaultValue: 'native-low' };
        if (caller === 'denied-grant') {
            await expect(store.resolveBinding(user, appId, service.id, { reasoning: { mode: 'explicit', value: 'native-low' } })).rejects.toMatchObject({ code: 'permission-denied' });
            expect(await context.database.aIServiceBinding.count({ where: { serviceId: service.id } })).toBe(0);
        } else {
            const binding = await store.resolveBinding(user, appId, service.id, { reasoning: { mode: 'explicit', value: 'native-low' } });
            expect(binding).toMatchObject({ revision: 1, requestedModel: null, reasoning: { mode: 'explicit', value: 'native-low' } });
            expect(await store.validateBinding(user, appId, binding.id)).toEqual(binding);
        }
        expect((await store.readRevision(owner, service.id, 1)).config.reasoning).toEqual({ mode: 'explicit', value: 'native-high' });
        expect((await store.readService(owner, service.id)).service.revision).toBe(1);
    });
    it('rejects unsupported or unknown explicit configuration before committing a revision', async () => {
        const service = await create();
        await expect(store.updateService(owner, service.id, 1, { ...config, modelId: 'unknown' })).rejects.toMatchObject({ code: 'model-unavailable' });
        expect((await store.readService(owner, service.id)).service.revision).toBe(1);
        catalog = null;
        await expect(store.createService(owner, { name: 'Unknown capabilities', config: { ...config, modelId: 'native-default' } })).rejects.toMatchObject({ code: 'machine-offline' });
    });
    it('loads administrator registrations, enforces exact origins, and returns safe owner references', async () => {
        const service = await create();
        await expect(store.readApplication(appId, 'https://advisor.paws.rodeo.evil.example')).rejects.toMatchObject({ code: 'permission-denied' });
        const policy = await store.registerApplication({ appId: 'test-second-app', name: 'Second application', origins: ['https://second.example'], capabilities: ['chat'], businessPrompt: { id: 'second', version: '1' } });
        expect((await store.readApplication(policy.appId, 'https://second.example')).appId).toBe('test-second-app');
        await store.registerAuthorization(owner, { id: `${owner}-grant`, kind: 'personal-grant', scope: { appId, serviceId: service.id, targets: [{ machineId: machine, engine: 'codex', accountRef: { kind: 'codex-profile', id: profile } }], permissions: ['chat'], expiresAt: null }, allowModelOverride: false, allowReasoningOverride: false });
        const grants = await store.listServiceAuthorizations(owner, service.id);
        expect(grants).toHaveLength(1);
        expect(grants[0]).toMatchObject({ scope: { appId, serviceId: service.id }, revokedAt: null });
        expect(JSON.stringify(grants)).not.toContain('auth-secret');
        await expect(store.listServiceAuthorizations(other, service.id)).rejects.toMatchObject({ code: 'service-not-found' });
    });
    it('retains history after disabling or deleting a service and blocks new bindings', async () => {
        const service = await create(); const binding = await store.resolveBinding(principal(), appId, service.id, {});
        await store.updateServiceMetadata(owner, service.id, 1, { enabled: false });
        await expect(store.resolveBinding(principal(), appId, service.id, {})).rejects.toMatchObject({ code: 'service-disabled' });
        await store.deleteService(owner, service.id, 1);
        expect(await store.listServices(owner)).toEqual([]);
        expect(await store.readBinding(principal(), appId, binding.id)).toEqual(binding);
        await expect(store.resolveBinding(principal(), appId, service.id, {})).rejects.toMatchObject({ code: 'service-not-found' });
    });
});

describe('additive AI service migration', () => {
    it('adds nullable target fingerprints while retaining grants written by an older server', async () => {
        const { pg, database } = await createTestDatabase(true);
        try {
            await database.account.create({ data: { id: 'migration-owner', publicKey: 'migration-owner' } });
            await database.machine.create({ data: { id: 'migration-machine', accountId: 'migration-owner', metadata: 'encrypted' } });
            await database.codexAccountProfile.create({ data: { id: 'migration-profile', accountId: 'migration-owner', displayName: 'Migration', externalAccountFingerprint: 'migration-identity', credential: Buffer.from('unused') } });
            await pg.exec(readFileSync(resolve('prisma/migrations/20261005000000_ai_services/migration.sql'), 'utf8'));
            const target = { engine: 'codex' as const, machineId: 'migration-machine', accountRef: { kind: 'codex-profile' as const, id: 'migration-profile' } };
            const service = await createAIServiceStore(database).createService('migration-owner', { name: 'Migration', config: { ...target, modelId: null, reasoning: { mode: 'default' } } });
            const scope = { appId, serviceId: service.id, targets: [target], permissions: ['chat'], expiresAt: null };
            const insertOldGrant = (id: string) => pg.query('INSERT INTO "AIServiceAuthorization" (id,"ownerId","appId","serviceId",kind,scope) VALUES ($1,$2,$3,$4,$5,$6)', [id, 'migration-owner', appId, service.id, 'personal-grant', JSON.stringify(scope)]);
            await insertOldGrant('before-upgrade');
            await pg.exec(readFileSync(resolve('prisma/migrations/20261007000000_ai_service_target_fingerprints/migration.sql'), 'utf8'));
            await insertOldGrant('after-upgrade');
            expect((await pg.query('SELECT id,scope,"targetFingerprints" FROM "AIServiceAuthorization" ORDER BY id')).rows).toEqual([
                { id: 'after-upgrade', scope, targetFingerprints: null }, { id: 'before-upgrade', scope, targetFingerprints: null },
            ]);
        } finally { await database.$disconnect(); await pg.close(); }
    }, 120000);
    it('upgrades a populated old database and preserves old and new data when old writers resume', async () => {
        const { pg, database } = await createTestDatabase(true);
        try {
            await database.account.create({ data: { id: 'legacy-owner', publicKey: 'legacy-owner' } });
            await database.machine.create({ data: { id: 'legacy-machine', accountId: 'legacy-owner', metadata: 'legacy-encrypted' } });
            await database.codexAccountProfile.create({ data: { id: 'legacy-profile', accountId: 'legacy-owner', displayName: 'Legacy', externalAccountFingerprint: 'legacy-identity', credential: Buffer.from('legacy-credential'), credentialVersion: 7 } });
            await pg.exec(readFileSync(resolve('prisma/migrations/20261005000000_ai_services/migration.sql'), 'utf8'));
            const service = await createAIServiceStore(database).createService('legacy-owner', { name: 'Migrated service', config: { engine: 'codex', machineId: 'legacy-machine', accountRef: { kind: 'codex-profile', id: 'legacy-profile' }, modelId: null, reasoning: { mode: 'default' } } });
            await pg.query('UPDATE "Machine" SET metadata = $1 WHERE id = $2', ['old-writer-encrypted', 'legacy-machine']);
            expect((await database.codexAccountProfile.findUniqueOrThrow({ where: { id: 'legacy-profile' } })).credentialVersion).toBe(7);
            expect((await database.machine.findUniqueOrThrow({ where: { id: 'legacy-machine' } })).metadata).toBe('old-writer-encrypted');
            expect((await createAIServiceStore(database).readService('legacy-owner', service.id)).service.name).toBe('Migrated service');
        } finally { await database.$disconnect(); await pg.close(); }
    }, 120000);
});
