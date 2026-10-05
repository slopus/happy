import { describe, expect, it } from 'vitest';
import * as wire from './index';

const codex = {
    machineId: 'machine-1', engine: 'codex',
    accountRef: { kind: 'codex-profile', id: 'profile-1' },
    modelId: 'gpt-6-astra', reasoning: { mode: 'default' },
};
const claude = {
    machineId: 'machine-1', engine: 'claude',
    accountRef: { kind: 'device-identity', machineId: 'machine-1', identityId: 'claude-1' },
    modelId: 'sonnet', reasoning: { mode: 'explicit', value: 'high' },
};
const binding = {
    id: 'binding-1', appId: 'relationship-advisor', serviceId: 'service-1', revision: 1,
    machineId: 'machine-1', engine: 'codex', accountRef: codex.accountRef,
    requestedModel: null, reasoning: { mode: 'default' }, permissions: ['chat'],
};
const turn = {
    id: 'turn-1', conversationId: 'conversation-1', requestId: 'request-1',
    binding, status: 'running', actual: { modelId: null, reasoning: null },
    createdAt: 1000, startedAt: 1001, completedAt: null, error: null,
};
const target = { machineId: 'machine-1', engine: 'codex', accountRef: codex.accountRef };
const scope = {
    appId: 'relationship-advisor', serviceId: 'service-1',
    targets: [target], permissions: ['chat'], expiresAt: null,
};
const policy = {
    appId: 'relationship-advisor', name: 'Relationship Advisor',
    origins: ['https://advisor.example'], capabilities: ['chat', 'images'],
    businessPrompt: { id: 'advisor', version: '1' },
};

describe('AI service configuration', () => {
    it('accepts engine-native account references without credentials', () => {
        expect(wire.parseServiceConfig(codex)).toEqual(codex);
        expect(wire.parseServiceConfig(claude)).toEqual(claude);
    });

    it.each([
        { ...codex, accountRef: claude.accountRef },
        { ...claude, accountRef: codex.accountRef },
        { ...claude, accountRef: { ...claude.accountRef, machineId: 'machine-2' } },
        { ...codex, accountRef: { ...codex.accountRef, token: 'secret' } },
        { ...codex, permissions: ['terminal'] },
        { ...codex, modelId: '' },
        { ...codex, machineId: '   ' },
    ])('rejects incompatible or unsafe configuration %j', value => {
        expect(wire.parseServiceConfig).toBeTypeOf('function');
        expect(() => wire.parseServiceConfig(value)).toThrow('invalid-service-config');
    });

    it('preserves explicit runtime defaults', () => {
        expect(wire.parseServiceConfig({ ...codex, modelId: null })).toMatchObject({
            modelId: null, reasoning: { mode: 'default' },
        });
    });

    it.each([
        { mode: 'explicit', value: '' }, { mode: 'explicit', value: '   ' },
        { mode: 'explicit' }, { mode: 'default', value: 'high' }, { mode: 'fast' },
    ])('rejects empty or non-native reasoning %j', reasoning => {
        expect(wire.parseServiceConfig).toBeTypeOf('function');
        expect(() => wire.parseServiceConfig({ ...codex, reasoning })).toThrow('invalid-service-config');
    });
});

describe('service revisions and execution records', () => {
    it('keeps service metadata separate from immutable configuration revisions', () => {
        expect(wire.ServiceRefSchema.parse({
            id: 'service-1', ownerId: 'owner-1', name: 'Personal service', enabled: true, revision: 2,
        })).toMatchObject({ revision: 2 });
        expect(wire.ServiceRevisionSchema.parse({
            serviceId: 'service-1', revision: 1, config: codex, createdAt: 1000,
        })).toMatchObject({ revision: 1, config: codex });
        expect(wire.ServiceRevisionSchema.safeParse({
            serviceId: 'service-1', revision: 0, config: codex, createdAt: 1000,
        }).success).toBe(false);
    });

    it('rejects bindings that cross engines, devices or tool permissions', () => {
        expect(wire.ExecutionBindingSchema.parse(binding)).toEqual(binding);
        for (const value of [
            { ...binding, engine: 'claude' },
            { ...binding, permissions: ['chat', 'terminal'] },
            { ...binding, engine: 'claude', accountRef: { ...claude.accountRef, machineId: 'machine-2' } },
        ]) expect(wire.ExecutionBindingSchema.safeParse(value).success).toBe(false);
    });

    it('requires actual values and does not copy requested settings', () => {
        expect(wire.parseTurnRecord({
            ...turn, binding: { ...binding, requestedModel: 'gpt-6-astra', reasoning: { mode: 'explicit', value: 'high' } },
        }).actual).toEqual({ modelId: null, reasoning: null });
        expect(wire.TurnRecordSchema.safeParse({ ...turn, actual: undefined }).success).toBe(false);
        expect(wire.TurnRecordSchema.safeParse({ ...turn, actual: {} }).success).toBe(false);
        expect(wire.parseTurnRecord({ ...turn, actual: { modelId: 'reported-model', reasoning: 'reported-effort' } }).actual)
            .toEqual({ modelId: 'reported-model', reasoning: 'reported-effort' });
    });

    it.each(['completed', 'failed', 'cancelled', 'interrupted'] as const)('accepts terminal %s results', status => {
        const result = { ...turn, status, completedAt: 1002, error: status === 'completed' ? null : {
            code: status === 'interrupted' ? 'execution-interrupted' : 'internal-error', retryable: false,
        } };
        expect(wire.parseTurnResult(result).status).toBe(status);
    });

    it('rejects unfinished results and inconsistent completion or error states', () => {
        expect(wire.TurnResultSchema.safeParse(turn).success).toBe(false);
        expect(wire.TurnRecordSchema.safeParse({ ...turn, status: 'completed', completedAt: null }).success).toBe(false);
        expect(wire.TurnRecordSchema.safeParse({ ...turn, completedAt: 1002 }).success).toBe(false);
        expect(wire.TurnRecordSchema.safeParse({ ...turn, status: 'completed', completedAt: 1002,
            error: { code: 'internal-error', retryable: false } }).success).toBe(false);
        expect(wire.TurnRecordSchema.safeParse({ ...turn, status: 'failed', completedAt: 1002 }).success).toBe(false);
    });
});

describe('account-scoped capabilities', () => {
    const catalog = {
        protocol: 'ai-services/1', ...target, observedAt: 1000, availability: 'online', completeness: 'limited',
        models: [{ id: 'gpt-6-astra', name: 'Codex', supportsImages: true,
            reasoning: { supportsDefault: true, values: ['high'], defaultValue: null } }], defaultModelId: null,
    };

    it('reports limited observations and unknown defaults without invented values', () => {
        expect(wire.CapabilityCatalogSchema.parse(catalog)).toEqual(catalog);
        expect(wire.CapabilityCatalogSchema.parse({ ...catalog, availability: 'offline' }).availability).toBe('offline');
        expect(wire.CapabilityCatalogSchema.parse({ ...catalog, engine: 'claude', accountRef: claude.accountRef,
            models: [{ id: 'sonnet', name: 'Sonnet', supportsImages: true,
                reasoning: { supportsDefault: true, values: [], defaultValue: null } }],
        }).completeness).toBe('limited');
    });

    it('rejects swapped account identity, unknown fields and mismatched native defaults', () => {
        expect(wire.CapabilityCatalogSchema.safeParse({ ...catalog, accountRef: claude.accountRef }).success).toBe(false);
        expect(wire.CapabilityCatalogSchema.safeParse({ ...catalog, token: 'secret' }).success).toBe(false);
        expect(wire.CapabilityCatalogSchema.safeParse({ ...catalog, models: [{ ...catalog.models[0],
            reasoning: { supportsDefault: true, values: ['high'], defaultValue: 'fast' } }],
        }).success).toBe(false);
    });
});

describe('trusted policies and scoped principals', () => {
    it('accepts registered policy references without execution overrides', () => {
        expect(wire.AppPolicySchema.parse(policy)).toEqual(policy);
        for (const extra of [
            { systemPrompt: 'Run a shell' }, { permissions: ['terminal'] },
            { accountRef: codex.accountRef }, { engine: 'claude' }, { modelId: 'opus' },
        ]) expect(wire.AppPolicySchema.safeParse({ ...policy, ...extra }).success).toBe(false);
        expect(wire.AppPolicySchema.safeParse({ ...policy, businessPrompt: {
            ...policy.businessPrompt, permissions: ['terminal'],
        } }).success).toBe(false);
    });

    it.each(['https://advisor.example/path', 'https://advisor.example/', 'https://user:pass@advisor.example',
        'https://advisor.example?x=1', '*', 'file:///tmp/policy'])('rejects untrusted origin syntax %s', origin => {
        expect(wire.AppPolicySchema.safeParse({ ...policy, origins: [origin] }).success).toBe(false);
    });

    it('distinguishes owner, platform grant and personal grant principals', () => {
        expect(wire.ServicePrincipalSchema.parse({ kind: 'owner', ownerId: 'owner-1' }).kind).toBe('owner');
        for (const kind of ['platform-grant', 'personal-grant']) {
            expect(wire.ServicePrincipalSchema.parse({ kind, ownerId: 'owner-1', grantId: 'grant-1', scope }).kind).toBe(kind);
        }
        expect(wire.ServicePrincipalSchema.safeParse({ kind: 'owner', ownerId: 'owner-1', scope }).success).toBe(false);
    });

    it('binds each approved account to its device and engine', () => {
        expect(wire.ServiceGrantScopeSchema.parse(scope)).toEqual(scope);
        expect(wire.ServiceGrantScopeSchema.safeParse({ ...scope, targets: [{
            ...target, engine: 'claude', accountRef: claude.accountRef,
        }] }).success).toBe(true);
        expect(wire.ServiceGrantScopeSchema.safeParse({ ...scope, targets: [{
            ...target, engine: 'claude', accountRef: codex.accountRef,
        }] }).success).toBe(false);
        expect(wire.ServiceGrantScopeSchema.safeParse({ ...scope, permissions: ['browser'] }).success).toBe(false);
    });

    it('separates an issuance receipt from safe grant metadata', () => {
        const metadata = { id: 'grant-1', ownerId: 'owner-1', kind: 'personal-grant',
            protocol: 'ai-services/1', scope, createdAt: 1000, revokedAt: null };
        const receipt = { ...metadata, credential: 'paws_service.synthetic', messageKey: 'synthetic-key' };
        expect(wire.GrantReceiptSchema.parse(receipt)).toEqual(receipt);
        expect(wire.ServiceGrantSchema.safeParse(receipt).success).toBe(false);
        expect(wire.GrantReceiptSchema.safeParse(metadata).success).toBe(false);
        expect(wire.ServiceGrantSchema.parse(metadata)).toEqual(metadata);
    });
});

describe('service errors and protocol negotiation', () => {
    it.each(['authorization-expired', 'authorization-revoked', 'machine-offline', 'account-login-required',
        'account-identity-changed', 'account-not-found', 'service-not-found', 'service-disabled',
        'model-unavailable', 'parameter-unsupported', 'quota-exhausted', 'execution-interrupted',
        'protocol-incompatible', 'consent-required', 'revision-conflict', 'permission-denied',
        'invalid-service-config', 'invalid-request', 'resource-busy', 'internal-error'])('accepts actionable %s codes', code => {
        expect(wire.ServiceErrorSchema.parse({ code, retryable: false })).toEqual({ code, retryable: false });
    });

    it('rejects raw logs, credentials and paths in error objects', () => {
        expect(wire.ServiceErrorSchema.safeParse({ code: 'machine-offline', retryable: true, logs: '/home/private' }).success).toBe(false);
        expect(wire.ServiceErrorSchema.safeParse({ code: 'unknown', retryable: false }).success).toBe(false);
    });

    it('negotiates new protocol only when both peers explicitly support it', () => {
        expect(wire.negotiateAppChatProtocol('ai-services/1', ['ai-services/1', 3])).toBe('ai-services/1');
        expect(wire.negotiateAppChatProtocol(3, ['ai-services/1', 3])).toBe(3);
        expect(wire.negotiateAppChatProtocol(undefined, [1, 'ai-services/1'])).toBe(1);
    });

    it('keeps old codex scopes on their numeric protocols', () => {
        expect(wire.parseAppChatProtocol({ protocol: 1, scope: 'codex:chat' })).toEqual({ protocol: 1, scope: 'codex:chat' });
        expect(wire.parseAppChatProtocol({ protocol: 2, scope: 'codex:chat' })).toEqual({ protocol: 2, scope: 'codex:chat' });
        expect(wire.parseAppChatProtocol({ scope: 'codex:chat' })).toEqual({ protocol: 1, scope: 'codex:chat' });
        expect(() => wire.parseAppChatProtocol({ protocol: 'ai-services/1', scope: 'codex:chat' })).toThrow('protocol-incompatible');
        expect(wire.parseAppChatSelection(undefined)).toEqual({ engine: 'codex', model: 'gpt-6-astra' });
    });

    it('rejects unsupported protocols and scope upgrades', () => {
        expect(wire.negotiateAppChatProtocol).toBeTypeOf('function');
        for (const protocol of ['ai-services/2', 4, null]) {
            expect(() => wire.negotiateAppChatProtocol(protocol, ['ai-services/1', 3])).toThrow('protocol-incompatible');
        }
        expect(() => wire.negotiateAppChatProtocol('ai-services/1', [1, 2, 3])).toThrow('protocol-incompatible');
        expect(() => wire.parseAppChatProtocol({ protocol: 1, scope: 'agent:chat' })).toThrow('protocol-incompatible');
        expect(() => wire.parseAppChatProtocol({ protocol: 3, scope: 'codex:chat' })).toThrow('protocol-incompatible');
        expect(wire.parseAppChatProtocol({ protocol: 3, scope: 'agent:chat' })).toEqual({ protocol: 3, scope: 'agent:chat' });
        expect(wire.parseAppChatProtocol({ protocol: 'ai-services/1', scope: 'service:chat' }))
            .toEqual({ protocol: 'ai-services/1', scope: 'service:chat' });
    });
});
