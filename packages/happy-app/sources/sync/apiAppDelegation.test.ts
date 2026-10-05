import { afterEach, expect, it, vi } from 'vitest';
import { appAuthorizationRequest, isAppGrantActive } from './apiAppDelegation';
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://paws.example' }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('supports the native AbortController without AbortSignal static methods and cleans its timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('AbortSignal', {});
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ grants: [] }) }));
    vi.stubGlobal('fetch', fetcher);
    expect(await appAuthorizationRequest('owner', '')).toEqual({ grants: [] });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
});

it('forwards cancellation when a panel closes and bounds an unresponsive request', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })));
    const cancellation = new AbortController();
    const request = appAuthorizationRequest('owner', '', undefined, 'GET', cancellation.signal);
    const cancelled = expect(request).rejects.toThrow('aborted');
    cancellation.abort();
    await cancelled;
    expect(vi.getTimerCount()).toBe(0);
    const timed = expect(appAuthorizationRequest('owner', '')).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(15_000);
    await timed;
    expect(vi.getTimerCount()).toBe(0);
});

it('treats explicit permanent approved grants as active but never revoked or pending ones', () => {
    const grant = { id: 'grant', appId: 'app', machineId: 'machine', state: 'redeemed', expiresAt: null, createdAt: '' };
    expect(isAppGrantActive(grant)).toBe(true);
    expect(isAppGrantActive({ ...grant, state: 'revoked' })).toBe(false);
    expect(isAppGrantActive({ ...grant, state: 'pending' })).toBe(false);
    expect(isAppGrantActive({ ...grant, expiresAt: new Date(0).toISOString() })).toBe(false);
});

import { appAuthorizationProtocol, sealServiceConsent } from './apiAppDelegation';
import sodium from 'libsodium-wrappers';
vi.mock('expo-crypto', () => ({ getRandomBytes: (size: number) => crypto.getRandomValues(new Uint8Array(size)) }));
vi.mock('@/encryption/base64', () => ({ encodeBase64: (v: Uint8Array) => Buffer.from(v).toString('base64'), decodeBase64: (v: string) => new Uint8Array(Buffer.from(v, 'base64')) }));
vi.mock('@/encryption/libsodium.lib', async () => ({ default: (await import('libsodium-wrappers')).default }));
it('dispatches explicit service links without changing legacy links or downgrading unknown protocols', () => {
    for (const version of [undefined, '1', '2', '3']) expect(appAuthorizationProtocol(version)).toBe('legacy');
    expect(appAuthorizationProtocol('ai-services/1')).toBe('ai-services/1');
    for (const version of ['ai-services/2', '4', ['ai-services/1']]) expect(appAuthorizationProtocol(version)).toBe('unsupported');
});
it('seals an app recipient and every distinct machine with exact grant context and no plaintext key', async () => {
    await sodium.ready;
    const app = sodium.crypto_box_keypair(), machine1 = sodium.crypto_box_keypair(), machine2 = sodium.crypto_box_keypair();
    const base64 = (v: Uint8Array) => Buffer.from(v).toString('base64');
    const target = { machineId: 'm1', engine: 'codex', accountRef: { kind: 'codex-profile', id: 'account' } } as const;
    const scope = { appId: 'advisor', serviceId: 's1', targets: [target, { ...target, machineId: 'm2' }], permissions: ['chat' as const], expiresAt: null };
    const service = { id: 's1', name: 'Assistant', ownerId: 'owner', enabled: true, revision: 1 };
    const pairing = { id: 'pairing', protocol: 'ai-services/1' as const, publicKey: base64(app.publicKey), expiresAt: Date.now() + 60000, app: { appId: 'advisor', name: 'Advisor', origins: ['https://advisor.example'], capabilities: ['chat' as const], businessPrompt: { id: 'p', version: '1' } } };
    const workers = [machine1, machine2].map((m, i) => ({ machineId: `m${i + 1}`, serviceProtocol: 'ai-services/1' as const, servicePublicKey: base64(m.publicKey), serviceClaudeIdentity: null, serviceClaudeObservedAt: null }));
    const sealed = await sealServiceConsent({ pairing, service, scope, workers });
    const open = (encoded: string, secret: Uint8Array) => { const box = Buffer.from(encoded, 'base64'); return JSON.parse(new TextDecoder().decode(sodium.crypto_box_open_easy(box.subarray(56), box.subarray(32, 56), box.subarray(0, 32), secret))); };
    const appData = open(sealed.appEnvelope, app.privateKey);
    expect(appData).toEqual({ protocol: 'ai-services/1', grantId: 'pairing', ownerId: 'owner', appId: 'advisor', serviceId: 's1', scope, messageKey: expect.any(String) });
    expect(Buffer.from(appData.messageKey, 'base64')).toHaveLength(32);
    expect(open(sealed.machineEnvelopes.m1, machine1.privateKey)).toEqual({ ...appData, machineId: 'm1' });
    expect(open(sealed.machineEnvelopes.m2, machine2.privateKey)).toEqual({ ...appData, machineId: 'm2' });
    expect(() => open(sealed.appEnvelope, machine1.privateKey)).toThrow();
    expect(JSON.stringify(sealed)).not.toContain(appData.messageKey);
    expect(Object.keys(sealed)).toEqual(['scope', 'appEnvelope', 'machineEnvelopes']);
    await expect(sealServiceConsent({ pairing, service, scope, workers: workers.slice(0, 1) })).rejects.toThrow('设备的加密密钥不可用');
    await expect(sealServiceConsent({ pairing, service, scope: { ...scope, appId: 'other' }, workers })).rejects.toThrow('授权范围无效');
});
