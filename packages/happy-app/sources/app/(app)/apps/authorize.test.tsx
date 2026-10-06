import * as React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { press, render } from '@/components/aiServices/testSupport';
import AuthorizeApp from './authorize';
const state = vi.hoisted(() => ({ protocol: undefined as string | undefined, legacy: vi.fn(), pairing: vi.fn(), push: vi.fn(), replace: vi.fn(), credentials: { token: 'synthetic' } as { token: string } | null }));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: '00000000-0000-0000-0000-000000000001', protocol: state.protocol }), useRouter: () => ({ push: state.push, replace: state.replace }), Stack: { Screen: () => null } }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ credentials: state.credentials }) }));
vi.mock('@/sync/storage', () => ({ useAllMachines: () => [] }));
vi.mock('@/sync/sync', () => ({ sync: {} }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn() }));
vi.mock('@/encryption/libsodium', () => ({ encryptBox: vi.fn() }));
vi.mock('@/encryption/base64', () => ({ encodeBase64: vi.fn(), decodeBase64: vi.fn() }));
vi.mock('@/text', () => ({ t: (s: string) => s }));
vi.mock('@/sync/apiAppDelegation', async () => ({ ...await vi.importActual('@/sync/apiAppDelegation'), appAuthorizationRequest: (...args: any[]) => state.legacy(...args) }));
vi.mock('@/sync/apiAIServices', () => ({ createAIServicesAPI: () => ({ pairing: (...args: any[]) => state.pairing(...args), list: async () => ({ services: [] }), workers: async () => ({ workers: [] }) }) }));
vi.mock('@/sync/apiCodexAccounts', () => ({ listCodexAccounts: async () => ({ profiles: [] }) }));
beforeEach(() => { state.credentials = { token: 'synthetic' }; state.push.mockClear(); state.replace.mockClear(); });
it('offers an explicit login route for the original service request when logged out', async () => {
    state.protocol = 'ai-services/1'; state.credentials = null; state.pairing.mockClear();
    const r = await render(<AuthorizeApp />);
    expect(state.pairing).not.toHaveBeenCalled();
    await press(r, '登录 Paws');
    expect(state.push).toHaveBeenCalledWith({ pathname: '/restore', params: {
        serviceAuthorizationId: '00000000-0000-0000-0000-000000000001', serviceAuthorizationProtocol: 'ai-services/1', serviceAuthorizationStartedAt: expect.any(String),
    } });
});
it('keeps legacy requests on their original endpoints', async () => {
    state.protocol = undefined; state.legacy.mockClear(); state.pairing.mockClear();
    state.legacy.mockImplementation(async (_token, path) => path === '/workers' ? { workers: [] } : { id: '00000000-0000-0000-0000-000000000001', app: { protocol: 3, name: 'Legacy', origin: 'https://legacy.example', scope: 'agent:chat' } });
    const r = await render(<AuthorizeApp />);
    expect(state.legacy).toHaveBeenCalledTimes(2); expect(state.pairing).not.toHaveBeenCalled();
    expect(JSON.stringify(r.toJSON())).toContain('Legacy');
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
    expect(state.legacy).not.toHaveBeenCalled(); expect(state.pairing).not.toHaveBeenCalled(); expect(JSON.stringify(r.toJSON())).toContain('不支持此授权协议');
});
