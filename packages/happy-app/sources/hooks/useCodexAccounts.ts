import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { getCurrentAuth, useAuth } from '@/auth/AuthContext';
import { getServerUrl } from '@/sync/serverConfig';
import { bindCodexAccount, CodexAccountError, createCodexSessionGrant, deleteCodexAccount, listCodexAccounts, renameCodexAccount,
    type CodexAccountErrorCode, type ListCodexAccountsResponse } from '@/sync/apiCodexAccounts';
import { apiSocket } from '@/sync/apiSocket';

type Snapshot = ListCodexAccountsResponse & { loading: boolean; busy: boolean; error: CodexAccountErrorCode | null };
type Change = { credentials: unknown; server: string; source: object };
const metadataChanges = new Set<(change: Change) => void>();
export type CodexAccountsController = Snapshot & {
    rename(profileId: string, name: string): Promise<boolean>;
    remove(profileId: string): Promise<boolean>;
    bind(machineId: string, profileId: string | null, expectedVersion: number): Promise<boolean>;
    refresh(profileId: string, machineId: string): Promise<boolean>;
};

/** Screen-scoped metadata. Reads follow mounts and account mutation events, never a timer. */
export function useCodexAccounts(): CodexAccountsController {
    const { credentials } = useAuth();
    const server = getServerUrl();
    const store = useMemo(() => {
        let mounted = false;
        let mountGeneration = 0;
        let readSequence = 0;
        let state: Snapshot = { profiles: [], bindings: [], migration: 'none', loading: true, busy: false, error: null };
        const listeners = new Set<() => void>();
        const source = {};
        const current = () => mounted && !!credentials && getCurrentAuth()?.credentials === credentials && getServerUrl() === server;
        const update = (patch: Partial<Snapshot>) => { if (current()) { state = { ...state, ...patch }; listeners.forEach(fn => fn()); } };
        const safeCode = (error: unknown): CodexAccountErrorCode => error instanceof CodexAccountError ? error.code : 'codex-account-operation-failed';
        async function load() {
            if (!current()) return;
            const sequence = ++readSequence;
            const generation = mountGeneration;
            const latest = () => generation === mountGeneration && sequence === readSequence;
            try { const result = await listCodexAccounts(credentials!); if (latest()) update({ ...result, loading: false, error: null }); }
            catch (error) { if (latest()) update({ loading: false, bindings: [], error: safeCode(error) }); }
        }
        const notifyOthers = () => metadataChanges.forEach(listener => listener({ credentials, server, source }));
        const onMetadataChange = (change: Change) => {
            if (!current() || change.source === source || change.credentials !== credentials || change.server !== server) return;
            update({ loading: true, error: null });
            void load();
        };
        async function mutate(action: () => Promise<void>): Promise<boolean> {
            if (!current() || state.busy || state.loading) return false;
            ++readSequence;
            update({ busy: true, error: null });
            try { await action(); return current(); }
            catch (error) {
                const code = safeCode(error);
                if (current() && ['binding-version-conflict', 'profile-not-found', 'codex-account-unavailable'].includes(code)) await load();
                update({ error: code }); return false;
            } finally { update({ busy: false }); }
        }
        return {
            getSnapshot: () => state,
            subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            open: () => {
                mounted = true;
                metadataChanges.add(onMetadataChange);
                const generation = ++mountGeneration;
                // AuthProvider publishes its global scope in a parent effect, after child effects.
                if (credentials) void Promise.resolve().then(() => { if (generation === mountGeneration) return load(); });
                else { state = { ...state, loading: false, error: 'authentication-required' }; listeners.forEach(fn => fn()); }
            },
            close: () => { mounted = false; ++mountGeneration; ++readSequence; metadataChanges.delete(onMetadataChange); },
            rename: (profileId: string, name: string) => mutate(async () => {
                const { profile } = await renameCodexAccount(credentials!, profileId, name);
                update({ profiles: state.profiles.map(p => p.id === profileId ? profile : p) });
            }),
            remove: (profileId: string) => mutate(async () => {
                await deleteCodexAccount(credentials!, profileId);
                // Clear visible references immediately; the read obtains the server's new binding versions.
                update({ profiles: state.profiles.filter(p => p.id !== profileId), bindings: state.bindings.filter(b => b.profileId !== profileId) });
                await load();
                notifyOthers();
            }),
            bind: (machineId: string, profileId: string | null, expectedVersion: number) => mutate(async () => {
                const { binding } = await bindCodexAccount(credentials!, machineId, { profileId, expectedVersion });
                update({ bindings: state.bindings.map(b => b.machineId === machineId ? binding : b) });
                notifyOthers();
            }),
            refresh: (profileId: string, machineId: string) => mutate(async () => {
                const binding = state.bindings.find(candidate => candidate.machineId === machineId);
                if (!binding || binding.profileId !== profileId) throw new CodexAccountError('binding-version-conflict');
                const grant = await createCodexSessionGrant(credentials!, machineId);
                if (grant.profile.id !== profileId) throw new CodexAccountError('binding-version-conflict');
                const result = await apiSocket.machineRPC<{ type: 'success'; accepted: boolean } | { type: 'error'; errorMessage: string }, { grant: string }>(
                    machineId, 'refresh-codex-account-quota', { grant: grant.grant }, { timeoutMs: 60_000, overallTimeoutMs: 70_000 },
                );
                if (result.type !== 'success') throw new CodexAccountError('codex-account-operation-failed');
                await load();
            }),
        };
    }, [credentials, server]);
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    useEffect(() => { store.open(); return store.close; }, [store]);
    return { ...state, rename: store.rename, remove: store.remove, bind: store.bind, refresh: store.refresh };
}
