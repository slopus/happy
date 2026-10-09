import * as React from 'react';
import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { press, render, snapshot, worker, account } from '@/components/aiServices/testSupport';
import AuthorizeApp from './authorize';
const state = vi.hoisted(() => ({ protocol: undefined as string | undefined, legacy: vi.fn(), create: vi.fn(), read: vi.fn(), grants: vi.fn(), approve: vi.fn(), list: vi.fn(), pairing: vi.fn(), push: vi.fn(), replace: vi.fn(), credentials: { token: 'synthetic' } as { token: string } | null }));
vi.mock('expo-router', () => ({ useFocusEffect: (callback: any) => React.useEffect(callback, [callback]), useLocalSearchParams: () => ({ id: '00000000-0000-0000-0000-000000000001', protocol: state.protocol }), useRouter: () => ({ push: state.push, replace: state.replace }), Stack: { Screen: () => null } }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ credentials: state.credentials }) }));
vi.mock('@/sync/storage', () => ({ useAllMachines: () => [] }));
vi.mock('@/sync/sync', () => ({ sync: {} }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn() }));
vi.mock('@/encryption/libsodium', () => ({ encryptBox: vi.fn() }));
vi.mock('@/encryption/base64', () => ({ encodeBase64: vi.fn(), decodeBase64: vi.fn() }));
vi.mock('@/text', () => ({ t: (s: string) => s }));
vi.mock('@/sync/apiAppDelegation', async () => ({ ...await vi.importActual('@/sync/apiAppDelegation'), sealServiceConsent: async ({ scope }: any) => ({ scope, appEnvelope: 'sealed', machineEnvelopes: {} }) }));
vi.mock('@/sync/apiAIServices', () => ({ createAIServicesAPI: () => ({ pairing: (...args: any[]) => state.pairing(...args), list: state.list, create: state.create, read: state.read, grants: state.grants, approve: state.approve, workers: async () => ({ workers: [worker] }) }) }));
vi.mock('@/sync/apiCodexAccounts', () => ({ listCodexAccounts: async () => ({ profiles: [] }) }));
vi.mock('@/components/aiServices/ServiceConsent', () => ({ ServiceConsent: 'ServiceConsent' }));
beforeEach(() => { state.list.mockReset().mockResolvedValue({ services: [] }); state.create.mockReset().mockResolvedValue({ service: snapshot.service }); state.read.mockReset().mockResolvedValue(snapshot); state.grants.mockReset().mockResolvedValue({ grants: [] }); state.approve.mockReset().mockResolvedValue({}); state.credentials = { token: 'synthetic' }; state.push.mockClear(); state.replace.mockClear(); });
it('rejects retired authorization links without making a legacy request', async () => {
    state.protocol = undefined; state.legacy.mockClear(); state.pairing.mockClear();
    const r = await render(<AuthorizeApp />);
    expect(state.legacy).not.toHaveBeenCalled(); expect(state.pairing).not.toHaveBeenCalled();
});
it('uses only the service pairing endpoint for the explicit new protocol', async () => {
    state.protocol = 'ai-services/1'; state.legacy.mockClear(); state.pairing.mockClear();
    state.pairing.mockRejectedValue(new Error('Synthetic pairing expired'));
    const r = await render(<AuthorizeApp />);
    expect(state.pairing).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000001'); expect(state.legacy).not.toHaveBeenCalled();
    expect(JSON.stringify(r.toJSON())).toContain('Synthetic pairing expired');
    expect(state.push).not.toHaveBeenCalled(); expect(state.replace).not.toHaveBeenCalled();
});
it('does not downgrade an unsupported protocol to legacy', async () => {
    state.protocol = 'ai-services/9'; state.legacy.mockClear(); state.pairing.mockClear();
    const r = await render(<AuthorizeApp />);
    expect(state.legacy).not.toHaveBeenCalled(); expect(state.pairing).not.toHaveBeenCalled(); expect(JSON.stringify(r.toJSON())).toContain('connectedApps.unsupported');
});

const servicePairing = { id: '00000000-0000-0000-0000-000000000001', protocol: 'ai-services/1', app: { appId: 'advisor', name: 'Advisor', origins: [], capabilities: ['chat'] }, expiresAt: Date.now() + 600000 };
const scope = { appId: 'advisor', targets: [snapshot.revision.config], permissions: ['chat'], expiresAt: null };
it('creates a connection from the selected configuration and reuses it after an approval retry', async () => {
    state.protocol = 'ai-services/1'; state.pairing.mockResolvedValue(servicePairing);
    state.approve.mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValue({});
    const r = await render(<AuthorizeApp />);
    const approve = r.root.findByType('ServiceConsent').props.onApprove;
    await expect(approve(snapshot.revision.config, scope)).rejects.toThrow('temporary failure');
    await approve(snapshot.revision.config, scope);
    expect(state.create).toHaveBeenCalledExactlyOnceWith('Advisor', snapshot.revision.config);
    expect(state.approve).toHaveBeenLastCalledWith(servicePairing.id, expect.objectContaining({ scope: expect.objectContaining({ serviceId: 's1' }) }));
});
it('reuses an identical configuration only if it is already linked to this application', async () => {
    state.protocol = 'ai-services/1'; state.pairing.mockResolvedValue(servicePairing);
    state.list.mockResolvedValue({ services: [snapshot.service] });
    state.grants.mockResolvedValue({ grants: [{ scope: { appId: 'advisor', serviceId: 's1' } }] });
    const r = await render(<AuthorizeApp />);
    await r.root.findByType('ServiceConsent').props.onApprove(snapshot.revision.config, scope);
    expect(state.create).not.toHaveBeenCalled(); expect(state.approve).toHaveBeenCalledOnce();
});
it('does not reuse another application configuration even when device and model match', async () => {
    state.protocol = 'ai-services/1'; state.pairing.mockResolvedValue(servicePairing);
    state.list.mockResolvedValue({ services: [snapshot.service] });
    state.grants.mockResolvedValue({ grants: [{ scope: { appId: 'another-app', serviceId: 's1' } }] });
    const r = await render(<AuthorizeApp />);
    await r.root.findByType('ServiceConsent').props.onApprove(snapshot.revision.config, scope);
    expect(state.create).toHaveBeenCalledOnce();
});
