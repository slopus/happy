import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { TokenStorage, AuthCredentials } from '@/auth/tokenStorage';
import * as Updates from 'expo-updates';
import { clearPersistence, loadRegisteredPushToken } from '@/sync/persistence';
import { Platform, AppState } from 'react-native';
import { router } from 'expo-router';
import { getServerUrl } from '@/sync/serverConfig';
import { apiSocket } from '@/sync/apiSocket';
import { saveAccountCredentials, selectSavedAccount, logoutSavedAccount, validateSavedAccount } from './accounts';
import { accountIndex, accountRuntimeCurrent, freezeAccountRuntime, getRuntimeAccountSelection } from './accountRuntime';
import { abortAccountRequests } from './accountNetwork';
import { retireAccountPush, retryAccountPushCleanup } from './accountPushCleanup';
import { useComposeDraft } from '@/sync/composeDraft';
import { Modal } from '@/modal';
import { t } from '@/text';
import { AccountTransitionScreen } from '@/components/accounts/AccountTransitionScreen';
import { trackLogout } from '@/track';
import { clearPublicSessionShareJobs } from '@/sync/publicSessionShareQueueRuntime';
import { clearSessionWarmCache } from '@/sync/sessionWarmCache';
import { clearLocalHistoryCaches } from '@/sync/localHistoryStore';
import { clearFirstSubmissionScope } from '@/sync/firstSubmissionScope';
import { sessionTextStream } from '@/sync/sessionTextStream';

interface AuthContextType {
    isAuthenticated: boolean;
    credentials: AuthCredentials | null;
    login: (token: string, secret: string) => Promise<void>;
    logout: () => Promise<void>;
    switchAccount: (key: string, sessionId?: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children, initialCredentials }: { children: ReactNode; initialCredentials: AuthCredentials | null }) {
    const [isAuthenticated, setIsAuthenticated] = useState(!!initialCredentials);
    const [credentials, setCredentials] = useState<AuthCredentials | null>(initialCredentials);
    const [transition, setTransition] = useState<'loading' | 'error' | null>(null);
    const transitionRef = useRef<(() => Promise<void>) | null>(null);
    const busy = useRef(false);

    const freeze = () => {
        freezeAccountRuntime();
        sessionTextStream.activate(null);
        clearFirstSubmissionScope();
        apiSocket.disconnect();
        abortAccountRequests();
        setTransition('loading');
    };
    const reload = async (path?: string) => {
        if (Platform.OS === 'web') {
            // replace also drops a previous account's open session route.
            window.location.replace(path || '/');
        } else {
            if (path) router.replace(path as any);
            await Updates.reloadAsync();
        }
    };
    const retryTransition = async () => {
        if (busy.current) return;
        busy.current = true;
        setTransition('loading');
        try { await transitionRef.current?.(); }
        catch { setTransition('error'); }
        finally { busy.current = false; }
    };
    const unregisterOldPush = async () => {
        const token = loadRegisteredPushToken();
        const selected = getRuntimeAccountSelection();
        if (!credentials || !token || !selected) return;
        await retireAccountPush({ accountKey: selected.key, serverUrl: getServerUrl(), pushToken: token, token: credentials.token });
    };
    const switchAccount = async (key: string, sessionId?: string) => {
        if (busy.current || transitionRef.current) return;
        if (sessionId && !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error('Invalid session');
        await validateSavedAccount(key);
        if (useComposeDraft.getState().images.length && !await Modal.confirm(t('accounts.switch'), t('accounts.attachmentWarning'))) return;
        if (busy.current || transitionRef.current) return;
        let committed = false;
        const path = sessionId ? `/session/${encodeURIComponent(sessionId)}` : '/';
        transitionRef.current = async () => {
            if (!committed) {
                await unregisterOldPush();
                await selectSavedAccount(key);
                // Native reload may restart at root: retain the intended route.
                if (Platform.OS !== 'web') accountIndex.set('pending-route', JSON.stringify({ key, path }));
                committed = true;
            }
            await reload(path);
        };
        freeze();
        await retryTransition();
    };

    useEffect(() => {
        const cleanupPush = () => { if (accountRuntimeCurrent()) void retryAccountPushCleanup().catch(() => undefined); };
        cleanupPush();
        const cleanupTimer = setInterval(cleanupPush, 60000);
        const check = () => {
            if (transitionRef.current) return;
            if (accountRuntimeCurrent()) { cleanupPush(); return; }
            transitionRef.current = () => reload('/');
            freeze();
            void retryTransition();
        };
        const subscription = AppState.addEventListener('change', check);
        if (Platform.OS === 'web') {
            window.addEventListener('storage', check);
            window.addEventListener('focus', check);
            document.addEventListener('visibilitychange', check);
        }
        return () => {
            clearInterval(cleanupTimer);
            subscription.remove();
            if (Platform.OS === 'web') {
                window.removeEventListener('storage', check);
                window.removeEventListener('focus', check);
                document.removeEventListener('visibilitychange', check);
            }
        };
    }, []);

    // Update global auth state when local state changes
    useEffect(() => {
        setCurrentAuth(credentials ? { isAuthenticated, credentials, login, logout, switchAccount } : null);
    }, [isAuthenticated, credentials]);

    const login = async (token: string, secret: string) => {
        const newCredentials: AuthCredentials = { token, secret };
        const account = await saveAccountCredentials(newCredentials, getServerUrl());
        await switchAccount(account.key);
    };

    const logout = async () => {
        if (busy.current || transitionRef.current) return;
        const oldGeneration = getRuntimeAccountSelection()?.generation;
        let committed = false;
        transitionRef.current = async () => {
            if (!committed) {
                await unregisterOldPush();
                await logoutSavedAccount(oldGeneration, async () => {
                    sessionTextStream.activate(null);
                    clearFirstSubmissionScope();
                    const clearingHistory = clearLocalHistoryCaches();
                    trackLogout();
                    clearPublicSessionShareJobs();
                    clearPersistence();
                    clearSessionWarmCache();
                    await clearingHistory;
                    await TokenStorage.removeCredentials();
                });
                committed = true;
            }
            setCredentials(null);
            setIsAuthenticated(false);
            await reload('/accounts');
        };
        freeze();
        await retryTransition();
    };

    return (
        <AuthContext.Provider
            value={{
                isAuthenticated,
                credentials,
                login,
                logout,
                switchAccount,
            }}
        >
            {transition ? <AccountTransitionScreen error={transition === 'error'} onRetry={() => void retryTransition()} onCancel={() => void reload('/accounts').catch(() => setTransition('error'))} /> : children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}

// Helper to get current auth state for non-React contexts
let currentAuthState: AuthContextType | null = null;

export function setCurrentAuth(auth: AuthContextType | null) {
    currentAuthState = auth;
}

export function getCurrentAuth(): AuthContextType | null {
    return currentAuthState;
}
