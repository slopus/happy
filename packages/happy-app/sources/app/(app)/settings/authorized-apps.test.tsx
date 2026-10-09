import * as React from 'react';
import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { render, press, snapshot, worker, account } from '@/components/aiServices/testSupport';
import AuthorizedApps from './authorized-apps';
const state = vi.hoisted(() => ({ revoke: vi.fn(), confirm: vi.fn(), grants: vi.fn(), read: vi.fn(), application: vi.fn(), token: 'owner' }));
vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useRouter: () => ({ push: vi.fn() }), useFocusEffect: (callback: any) => React.useEffect(callback, [callback]) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ credentials: { token: state.token } }) }));
vi.mock('@/sync/storage', () => ({ useAllMachines: () => [] }));
vi.mock('@/sync/apiCodexAccounts', () => ({ listCodexAccounts: async () => ({ profiles: [account] }) }));
vi.mock('@/sync/apiAIServices', () => ({ createAIServicesAPI: () => ({ grants: state.grants, list: async () => ({ services: [snapshot.service] }), read: state.read, workers: async () => ({ workers: [worker] }), application: state.application, revoke: state.revoke }) }));
vi.mock('@/components/aiServices/ServiceEditor', () => ({ ServiceEditor: 'ServiceEditor', targetDescription: () => 'Mac · Codex · Work' }));
vi.mock('@/modal', () => ({ Modal: { confirm: state.confirm } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
const grant = { id: 'g1', revokedAt: null, scope: { appId: 'advisor', serviceId: 's1', targets: [snapshot.revision.config], permissions: ['chat', 'images'], expiresAt: null } };
beforeEach(() => { state.application.mockReset().mockResolvedValue({ app: { appId: 'advisor', name: 'Advisor', origins: ['https://advisor.example'] } }); state.token = 'owner'; state.grants.mockReset().mockResolvedValue({ grants: [grant] }); state.read.mockReset().mockResolvedValue(snapshot); state.confirm.mockReset().mockResolvedValue(true); state.revoke.mockReset().mockResolvedValue({ revoked: true }); });
it('lists service grants and revokes the exact grant only after confirmation', async () => {
    const r = await render(<AuthorizedApps />);
    expect(JSON.stringify(r.toJSON())).toContain('Advisor');
    expect(JSON.stringify(r.toJSON())).toContain('connectedApps.images');
    state.confirm.mockResolvedValueOnce(false);
    await press(r, 'appAuthorization.revoke');
    expect(state.revoke).not.toHaveBeenCalled();
    state.grants.mockResolvedValue({ grants: [{ ...grant, revokedAt: 1 }] });
    await press(r, 'appAuthorization.revoke');
    expect(state.revoke).toHaveBeenCalledExactlyOnceWith('g1');
    expect(JSON.stringify(r.toJSON())).toContain('appAuthorization.revoked');
    expect(r.root.findAllByType('Button').filter((n: any) => n.props.title === 'appAuthorization.revoke')).toHaveLength(0);
});
it('opens the bound configuration with all affected grants and returns after saving', async () => {
    const r = await render(<AuthorizedApps />);
    await press(r, 'connectedApps.editConfiguration');
    const editor = r.root.findByType('ServiceEditor');
    expect(editor.props.snapshot).toEqual(snapshot); expect(editor.props.grants).toEqual([grant]);
    await act(async () => editor.props.onSaved());
    expect(r.root.findAllByType('ServiceEditor')).toHaveLength(0);
});
it('does not expose previous-owner grants after the account changes and loading fails', async () => {
    const r = await render(<AuthorizedApps />);
    state.token = 'another-owner'; state.grants.mockRejectedValue(new Error('Synthetic network failure'));
    await act(async () => r.update(<AuthorizedApps />));
    expect(JSON.stringify(r.toJSON())).not.toContain('Advisor');
    expect(JSON.stringify(r.toJSON())).toContain('Synthetic network failure');
});

it('keeps revoked or disabled application metadata failures from hiding other grants', async () => {
    state.grants.mockResolvedValue({ grants: [grant, { ...grant, id: 'g2', scope: { ...grant.scope, appId: 'disabled-app' } }] });
    state.application.mockImplementation(async (id: string) => { if (id === 'disabled-app') throw new Error('permission-denied'); return { app: { appId: 'advisor', name: 'Advisor', origins: [] } }; });
    const r = await render(<AuthorizedApps />);
    expect(JSON.stringify(r.toJSON())).toContain('disabled-app');
    expect(JSON.stringify(r.toJSON())).toContain('Advisor');
    expect(r.root.findAllByType('Button').filter((n: any) => n.props.title === 'appAuthorization.revoke')).toHaveLength(2);
});
