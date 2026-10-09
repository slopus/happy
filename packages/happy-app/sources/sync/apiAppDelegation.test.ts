import { expect, it, vi } from 'vitest';
import { appAuthorizationProtocol, sealServiceConsent } from './apiAppDelegation';
import sodium from 'libsodium-wrappers';
vi.mock('expo-crypto', () => ({ getRandomBytes: (size: number) => crypto.getRandomValues(new Uint8Array(size)) }));
vi.mock('@/encryption/base64', () => ({ encodeBase64: (v: Uint8Array) => Buffer.from(v).toString('base64'), decodeBase64: (v: string) => new Uint8Array(Buffer.from(v, 'base64')) }));
vi.mock('@/encryption/libsodium.lib', async () => ({ default: (await import('libsodium-wrappers')).default }));
it('dispatches explicit service links and rejects all retired protocols', () => {
    for (const version of [undefined, '1', '2', '3']) expect(appAuthorizationProtocol(version)).toBe('unsupported');
    expect(appAuthorizationProtocol('ai-services/1')).toBe('ai-services/1');
    for (const version of ['ai-services/2', '4', ['ai-services/1']]) expect(appAuthorizationProtocol(version)).toBe('unsupported');
});
it.each([
    { label: 'chat only', permissions: ['chat' as const] },
    { label: 'chat and tools', permissions: ['chat' as const, 'tools' as const] },
])('seals exactly $label for the app and every distinct machine', async ({ permissions }) => {
    await sodium.ready;
    const app = sodium.crypto_box_keypair(), machine1 = sodium.crypto_box_keypair(), machine2 = sodium.crypto_box_keypair();
    const base64 = (v: Uint8Array) => Buffer.from(v).toString('base64');
    const target = { machineId: 'm1', engine: 'codex', accountRef: { kind: 'codex-profile', id: 'account' } } as const;
    const scope = { appId: 'advisor', serviceId: 's1', targets: [target, { machineId: 'm1', engine: 'claude' as const, accountRef: { kind: 'device-identity' as const, machineId: 'm1', identityId: 'claude:observed' } }, { ...target, machineId: 'm2' }], permissions, expiresAt: null };
    const service = { id: 's1', name: 'Assistant', ownerId: 'owner', enabled: true, revision: 1 };
    const pairing = { id: 'pairing', protocol: 'ai-services/1' as const, publicKey: base64(app.publicKey), expiresAt: Date.now() + 60000, app: { appId: 'advisor', name: 'Advisor', origins: ['https://advisor.example'], capabilities: ['chat' as const, 'tools' as const], businessPrompt: { id: 'p', version: '1' } } };
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
    expect(Object.keys(sealed.machineEnvelopes)).toEqual(['m1', 'm2']);
    await expect(sealServiceConsent({ pairing, service, scope, workers: workers.slice(0, 1) })).rejects.toThrow('设备的加密密钥不可用');
    await expect(sealServiceConsent({ pairing, service, scope: { ...scope, appId: 'other' }, workers })).rejects.toThrow('授权范围无效');
    await expect(sealServiceConsent({ pairing: { ...pairing, app: { ...pairing.app, capabilities: ['chat'] } }, service, scope: { ...scope, permissions: ['chat', 'tools'] }, workers })).rejects.toThrow('授权范围无效');
});
