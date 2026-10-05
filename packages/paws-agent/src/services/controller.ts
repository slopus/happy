import type { AIServiceClient } from './client';
import { safeServiceError } from './client';
import { validateOverrides } from './scopedTransport';
import { AIServiceClientError, type AuthorizeOptions, type AuthorizationPending, type BindingOverrides, type CapabilityCatalog, type ClientErrorCode, type GrantReceipt, type ServiceConnection, type ServiceSource } from './types';
import type { ServiceStorage, StorageStatus, StorageInvalidation } from './storage';
export type ServiceControllerStatus = 'disconnected' | 'authorizing' | 'ready' | 'machine-offline' | 'account-login-required' | 'quota-exhausted' | 'authorization-revoked' | 'authorization-expired' | 'protocol-incompatible' | 'error';
export interface ServiceControllerState {
    source: ServiceSource;
    status: ServiceControllerStatus;
    connection: ServiceConnection | null;
    pending: AuthorizationPending | null;
    catalog: CapabilityCatalog | null;
    overrides: BindingOverrides;
    error: {
        code: ClientErrorCode;
        retryable: boolean;
    } | null;
    storage: StorageStatus;
}
export type ServiceControllerEvent = {
    type: 'state';
    state: ServiceControllerState;
} | {
    type: 'invalidated';
    reason: StorageInvalidation;
};
export type ServiceClients = Partial<Record<ServiceSource, AIServiceClient>>;
/** Pass both clients for a source selector. A single client is also supported. Credentials stay out of state/events. */
export function createServiceController(client: AIServiceClient | ServiceClients, storage: ServiceStorage) {
    const clients: ServiceClients = 'source' in client ? { [client.source]: client } : client;
    let state: ServiceControllerState = { source: clients.platform ? 'platform' : 'personal', status: 'disconnected', connection: null, pending: null, catalog: null, overrides: {}, error: null, storage: storage.getStatus() };
    let disposed = false, generation = 0, authorization: AbortController | null = null;
    const listeners = new Set<(event: ServiceControllerEvent) => void>();
    const snapshot = () => structuredClone(state);
    const open = () => { if (disposed)
        throw new AIServiceClientError('disposed'); };
    const emit = () => { if (!disposed)
        for (const listener of listeners)
            listener({ type: 'state', state: snapshot() }); };
    const selected = () => { const value = clients[state.source]; if (!value)
        throw new AIServiceClientError('consent-required'); return value; };
    function reset() { generation++; authorization?.abort(); authorization = null; for (const c of Object.values(clients))
        c?.connections.disconnect(); state = { ...state, status: 'disconnected', connection: null, pending: null, catalog: null, error: null }; }
    const unsubscribe = storage.subscribe?.(reason => { if (disposed)
        return; reset(); state.storage = storage.getStatus(); emit(); for (const listener of listeners)
        listener({ type: 'invalidated', reason }); });
    async function connect(options: AuthorizeOptions & {
        remember?: boolean;
    } = {}) {
        open();
        const current = ++generation;
        authorization?.abort();
        authorization = new AbortController();
        const signal = options.signal ? AbortSignal.any([authorization.signal, options.signal]) : authorization.signal;
        const active = selected();
        state = { ...state, status: 'authorizing', pending: null, error: null };
        emit();
        try {
            if (options.remember !== undefined)
                state.storage = await storage.remember?.(options.remember) ?? storage.getStatus();
            const receipt = options.receipt ?? (state.source === 'personal' ? await storage.get<GrantReceipt>('connection') ?? undefined : undefined);
            const connection = await active.connections.authorize({ receipt, signal, onPending: pending => { if (current !== generation || disposed)
                    return; state = { ...state, pending }; emit(); options.onPending?.(pending); } });
            if (disposed || current !== generation)
                return;
            state = { ...state, status: 'ready', connection, pending: null, error: null, storage: storage.getStatus() };
            emit();
            return connection;
        }
        catch (error) {
            if (disposed || current !== generation)
                return;
            const safe = safeServiceError(error);
            const status: ServiceControllerStatus = ['machine-offline', 'account-login-required', 'quota-exhausted', 'authorization-revoked', 'authorization-expired', 'protocol-incompatible'].includes(safe.code) ? safe.code as ServiceControllerStatus : safe.code === 'aborted' ? 'disconnected' : 'error';
            state = { ...state, status, pending: null, connection: null, error: { code: safe.code, retryable: safe.retryable }, storage: storage.getStatus() };
            emit();
            throw safe;
        }
    }
    return {
        getState: snapshot,
        subscribe(listener: (event: ServiceControllerEvent) => void) { open(); listeners.add(listener); listener({ type: 'state', state: snapshot() }); return () => listeners.delete(listener); },
        selectSource(source: ServiceSource) { open(); if (!clients[source])
            throw new AIServiceClientError('consent-required'); if (source === state.source)
            return; reset(); state = { ...state, source, overrides: {} }; emit(); },
        connect,
        /** Explicit async refresh recovery; construction does not start network calls or idle polling. */
        restore: () => connect(),
        async refresh() { open(); const active = selected(), current = generation; try {
            const catalog = await active.capabilities.read();
            if (disposed || current !== generation)
                return;
            state = { ...state, catalog, status: catalog?.availability === 'offline' ? 'machine-offline' : 'ready', error: null };
            emit();
            return catalog;
        }
        catch (error) {
            const safe = safeServiceError(error);
            if (!disposed && current === generation) {
                state = { ...state, status: 'error', error: { code: safe.code, retryable: safe.retryable } };
                emit();
            }
            throw safe;
        } },
        async disconnect(reason: 'disconnect' | 'forget' | 'logout' | 'revoke' = 'disconnect') {
            open();
            const active = selected();
            if (reason === 'revoke')
                await active.connections.revoke();
            reset();
            if (reason !== 'disconnect')
                await storage.clear(reason);
            else
                await storage.remove('pending-authorization');
            state.storage = storage.getStatus();
            emit();
        },
        setOverrides(overrides: BindingOverrides) { open(); state = { ...state, overrides: validateOverrides(overrides) }; emit(); },
        /** Snapshot overrides when creating a new conversation. Existing bindings are not changed. */
        createConversation(appConversationId?: string) { open(); if (state.status !== 'ready')
            throw new AIServiceClientError('consent-required'); return selected().conversations.create({ appConversationId, overrides: structuredClone(state.overrides) }); },
        dispose() { if (disposed)
            return; disposed = true; generation++; authorization?.abort(); unsubscribe?.(); listeners.clear(); for (const c of Object.values(clients))
            c?.dispose(); storage.dispose(); },
    };
}
export type ServiceController = ReturnType<typeof createServiceController>;
