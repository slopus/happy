import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    clearPersistence: vi.fn(),
    clearSessionWarmCache: vi.fn(),
    clearLocalHistoryCaches: vi.fn(async () => undefined),
    removeCredentials: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    validateSavedAccount: vi.fn(async (_key: string) => undefined),
    selectSavedAccount: vi.fn(async (_key: string) => undefined),
    freezeAccountRuntime: vi.fn(),
    disconnect: vi.fn(),
    abortAccountRequests: vi.fn(),
    logoutSavedAccount: vi.fn(async (_generation: string | undefined, cleanup: () => Promise<void>) => cleanup()),
    composeDraft: { images: [] as unknown[] },
    confirm: vi.fn(async () => true),
    retireAccountPush: vi.fn(async () => undefined),
    retryAccountPushCleanup: vi.fn(async () => undefined),
    saveAccountCredentials: vi.fn(async () => ({ key: 'restored-account' })),
    replace: vi.fn(),
    webReplace: vi.fn(),
    platform: { OS: 'native' },
}));

vi.mock('react-native', () => ({ Platform: mocks.platform, AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) } }));
vi.mock('expo-router', () => ({ router: { replace: mocks.replace } }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://paws.example' }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { disconnect: mocks.disconnect } }));
vi.mock('@/auth/accounts', () => ({
    validateSavedAccount: mocks.validateSavedAccount,
    selectSavedAccount: mocks.selectSavedAccount,
    saveAccountCredentials: mocks.saveAccountCredentials,
    logoutSavedAccount: mocks.logoutSavedAccount,
}));
vi.mock('@/auth/accountRuntime', () => ({
    accountIndex: { set: vi.fn() },
    accountRuntimeCurrent: () => true,
    freezeAccountRuntime: mocks.freezeAccountRuntime,
    getRuntimeAccountSelection: () => ({ generation: 'A' }),
}));
vi.mock('@/auth/accountNetwork', () => ({ abortAccountRequests: mocks.abortAccountRequests, accountCleanupFetch: vi.fn() }));
vi.mock('@/auth/accountPushCleanup', () => ({ retireAccountPush: mocks.retireAccountPush, retryAccountPushCleanup: mocks.retryAccountPushCleanup }));
vi.mock('@/sync/composeDraft', () => ({ useComposeDraft: { getState: () => mocks.composeDraft } }));
vi.mock('@/modal', () => ({ Modal: { confirm: mocks.confirm } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/components/accounts/AccountTransitionScreen', () => ({ AccountTransitionScreen: () => null }));
vi.mock('@/sync/firstSubmissionScope', () => ({ clearFirstSubmissionScope: vi.fn() }));
vi.mock('@/sync/sessionTextStream', () => ({ sessionTextStream: { activate: vi.fn() } }));
vi.mock('expo-updates', () => ({ reloadAsync: mocks.reload }));
vi.mock('@/auth/tokenStorage', () => ({
    TokenStorage: {
        removeCredentials: mocks.removeCredentials,
        setCredentials: vi.fn(async () => true),
    },
}));
vi.mock('@/sync/sync', () => ({ syncCreate: vi.fn() }));
vi.mock('@/sync/persistence', () => ({
    clearPersistence: mocks.clearPersistence,
    loadRegisteredPushToken: vi.fn(() => null),
}));
vi.mock('@/sync/sessionWarmCache', () => ({
    clearSessionWarmCache: mocks.clearSessionWarmCache,
}));
vi.mock('@/sync/localHistoryStore', () => ({ clearLocalHistoryCaches: mocks.clearLocalHistoryCaches }));
vi.mock('@/sync/apiPush', () => ({ unregisterPushToken: vi.fn() }));
vi.mock('@/track', () => ({ trackLogout: vi.fn() }));
vi.mock('@/sync/publicSessionShareQueueRuntime', () => ({ clearPublicSessionShareJobs: vi.fn() }));
vi.mock('@/sync/messageStagingQueueRuntime', () => ({ clearMessageStagingQueue: vi.fn() }));

import { AuthProvider, getCurrentAuth, useAuth } from './AuthContext';
import { createServiceAuthorizationLogin, serviceAuthorizationReturnPath } from './serviceAuthorizationLogin';

describe('AuthProvider logout', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        mocks.composeDraft.images = [];
        mocks.platform.OS = 'native';
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('clears the encrypted session warm cache with the rest of local account data', async () => {
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <AuthProvider initialCredentials={{ token: 'token', secret: 'secret' }}>
                    <></>
                </AuthProvider>,
            );
        });

        await act(async () => {
            await getCurrentAuth()?.logout();
        });

        expect(mocks.clearPersistence).toHaveBeenCalledOnce();
        expect(mocks.clearSessionWarmCache).toHaveBeenCalledOnce();
        expect(mocks.clearLocalHistoryCaches).toHaveBeenCalledOnce();
        expect(mocks.clearLocalHistoryCaches.mock.invocationCallOrder[0]).toBeLessThan(mocks.removeCredentials.mock.invocationCallOrder[0]);
        expect(mocks.removeCredentials).toHaveBeenCalledOnce();
        expect(mocks.logoutSavedAccount).toHaveBeenCalledWith('A', expect.any(Function));
        await act(async () => renderer.unmount());
    });

    it('switches accounts without clearing drafts, history, or saved credentials', async () => {
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<AuthProvider initialCredentials={{ token: 'token', secret: 'secret' }}><></></AuthProvider>);
        });
        await act(async () => { await getCurrentAuth()?.switchAccount('account-B', 'session-B'); });
        expect(mocks.validateSavedAccount).toHaveBeenCalledWith('account-B');
        expect(mocks.selectSavedAccount).toHaveBeenCalledWith('account-B');
        expect(mocks.freezeAccountRuntime).toHaveBeenCalledOnce();
        expect(mocks.reload).toHaveBeenCalledOnce();
        expect(mocks.clearPersistence).not.toHaveBeenCalled();
        expect(mocks.clearLocalHistoryCaches).not.toHaveBeenCalled();
        expect(mocks.clearSessionWarmCache).not.toHaveBeenCalled();
        expect(mocks.removeCredentials).not.toHaveBeenCalled();
        await act(async () => renderer.unmount());
    });

    it('keeps the current account usable when target validation fails', async () => {
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<AuthProvider initialCredentials={{ token: 'token', secret: 'secret' }}><></></AuthProvider>);
        });
        mocks.validateSavedAccount.mockRejectedValueOnce(new Error('account unavailable'));
        await act(async () => {
            await expect(getCurrentAuth()!.switchAccount('missing-account')).rejects.toThrow('account unavailable');
        });
        expect(mocks.freezeAccountRuntime).not.toHaveBeenCalled();
        expect(mocks.disconnect).not.toHaveBeenCalled();
        expect(mocks.abortAccountRequests).not.toHaveBeenCalled();
        expect(mocks.selectSavedAccount).not.toHaveBeenCalled();
        expect(mocks.reload).not.toHaveBeenCalled();
        expect(getCurrentAuth()?.isAuthenticated).toBe(true);
        await act(async () => renderer.unmount());
    });

    it('does not freeze or switch when attachment confirmation is cancelled', async () => {
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<AuthProvider initialCredentials={{ token: 'token', secret: 'secret' }}><></></AuthProvider>);
        });
        mocks.composeDraft.images = [{ id: 'unsent-image' }];
        mocks.confirm.mockResolvedValueOnce(false);
        await act(async () => { await getCurrentAuth()?.switchAccount('account-B'); });
        expect(mocks.confirm).toHaveBeenCalledWith('accounts.switch', 'accounts.attachmentWarning');
        expect(mocks.freezeAccountRuntime).not.toHaveBeenCalled();
        expect(mocks.disconnect).not.toHaveBeenCalled();
        expect(mocks.abortAccountRequests).not.toHaveBeenCalled();
        expect(mocks.selectSavedAccount).not.toHaveBeenCalled();
        expect(mocks.retireAccountPush).not.toHaveBeenCalled();
        expect(mocks.reload).not.toHaveBeenCalled();
        expect(mocks.composeDraft.images).toEqual([{ id: 'unsent-image' }]);
        expect(getCurrentAuth()?.isAuthenticated).toBe(true);
        await act(async () => renderer.unmount());
    });

    it.each([false, true])('reloads a previously logged-out account at the explicit service consent only (%s)', async serviceLogin => {
        mocks.platform.OS = 'web';
        vi.stubGlobal('window', { location: { replace: mocks.webReplace }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
        vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
        let renderer: any, auth!: ReturnType<typeof useAuth>;
        const Capture = () => { auth = useAuth(); return null; };
        await act(async () => { renderer = TestRenderer.create(<AuthProvider initialCredentials={null}><Capture /></AuthProvider>); });
        expect(auth.isAuthenticated).toBe(false);
        const intent = createServiceAuthorizationLogin('00000000-0000-0000-0000-000000000001')!;
        await act(async () => {
            if (serviceLogin) await auth.login('token', 'secret', { serviceAuthorization: intent });
            else await auth.login('token', 'secret');
        });
        expect(mocks.selectSavedAccount).toHaveBeenCalledWith('restored-account');
        expect(mocks.webReplace).toHaveBeenCalledWith(serviceLogin ? serviceAuthorizationReturnPath(intent) : '/');
        expect(mocks.replace).not.toHaveBeenCalled(); expect(mocks.reload).not.toHaveBeenCalled();
        await act(async () => renderer.unmount());
    });

    it('rejects an injected external login destination while keeping ordinary account activation', async () => {
        let renderer: any, auth!: ReturnType<typeof useAuth>;
        const Capture = () => { auth = useAuth(); return null; };
        await act(async () => { renderer = TestRenderer.create(<AuthProvider initialCredentials={null}><Capture /></AuthProvider>); });
        await act(async () => { await auth.login('token', 'secret', { serviceAuthorization: 'https://evil.example' } as any); });
        expect(mocks.replace).toHaveBeenCalledWith('/');
        expect(mocks.replace).not.toHaveBeenCalledWith('https://evil.example');
        await act(async () => renderer.unmount());
    });

    it.each(['save', 'validate'])('does not activate a cancelled service login while %s is pending', async stage => {
        let renderer: any, auth!: ReturnType<typeof useAuth>, finish!: () => void;
        const Capture = () => { auth = useAuth(); return null; };
        await act(async () => { renderer = TestRenderer.create(<AuthProvider initialCredentials={null}><Capture /></AuthProvider>); });
        const pause = new Promise<void>(resolve => { finish = resolve; });
        if (stage === 'save') mocks.saveAccountCredentials.mockImplementationOnce(async () => { await pause; return { key: 'cancelled-account' }; });
        else mocks.validateSavedAccount.mockImplementationOnce(async () => { await pause; });
        const controller = new AbortController();
        let pending!: Promise<void>;
        await act(async () => { pending = auth.login('token', 'secret', { serviceAuthorization: createServiceAuthorizationLogin('00000000-0000-0000-0000-000000000001')!, signal: controller.signal }); });
        controller.abort();
        await act(async () => { finish(); await pending; });
        expect(mocks.selectSavedAccount).not.toHaveBeenCalled(); expect(mocks.freezeAccountRuntime).not.toHaveBeenCalled(); expect(mocks.replace).not.toHaveBeenCalled();
        await act(async () => renderer.unmount());
    });
});
