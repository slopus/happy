/**
 * Moltbot Unified Connection Interface
 *
 * Provides a unified connection abstraction that works with both tunnel and direct
 * connection modes. This allows the UI layer to work with a consistent API regardless
 * of the underlying connection mechanism.
 *
 * The unified interface:
 * - Accepts a MoltbotMachine and automatically chooses tunnel or direct based on machine type
 * - Provides a common interface for connect/send/close operations
 * - Handles pairing data updates
 * - Manages connection lifecycle
 */

import * as React from 'react';
import {
    MoltbotTunnelClient,
    createTunnelClient,
    type TunnelConnectResult,
    type TunnelSendResult,
    type TunnelEventCallback,
    type TunnelStatusCallback,
} from './tunnelClient';
import {
    MoltbotDirectClient,
    createDirectClient,
    type DirectConnectResult,
    type DirectSendResult,
    type DirectClientEventCallback,
    type DirectClientStatusCallback,
} from './directClient';
import type {
    MoltbotMachine,
    MoltbotConnectionStatus,
    MoltbotPairingData,
} from './types';
import { useMoltbotMachine, useMachine } from '@/sync/storage';

// === Common Types ===

/**
 * Unified connection result type
 */
export interface ConnectionResult {
    ok: boolean;
    status: MoltbotConnectionStatus;
    error?: string;
    mainSessionKey?: string;
    serverHost?: string;
    pairingRequestId?: string;
    deviceToken?: string;
}

/**
 * Unified send result type
 */
export interface SendResult {
    ok: boolean;
    payload?: unknown;
    error?: string;
}

/**
 * Event callback type for unified interface
 */
export type ConnectionEventCallback = (event: string, payload: unknown) => void;

/**
 * Status change callback type for unified interface
 */
export type ConnectionStatusCallback = (status: MoltbotConnectionStatus, error?: string) => void;

/**
 * Options for creating a connection
 */
export interface ConnectionOptions {
    /** Callback for gateway events */
    onEvent?: ConnectionEventCallback;
    /** Callback for status changes */
    onStatusChange?: ConnectionStatusCallback;
    /** Callback when a new device token is received (after pairing) */
    onDeviceToken?: (deviceToken: string) => void;
}

// === Unified Connection Interface ===

/**
 * Common interface that both tunnel and direct clients satisfy
 */
export interface MoltbotConnection {
    /** The type of connection */
    readonly connectionType: 'tunnel' | 'direct';

    /** Get current connection status */
    getStatus(): MoltbotConnectionStatus;

    /** Get main session key (available after successful connection) */
    getMainSessionKey(): string | null;

    /** Get server host (available after successful connection) */
    getServerHost(): string | null;

    /** Get pairing request ID (available when pairing is required) */
    getPairingRequestId(): string | null;

    /** Get device token (available after successful pairing) */
    getDeviceToken(): string | null;

    /** Connect to the Moltbot gateway */
    connect(): Promise<ConnectionResult>;

    /** Send a request to the Moltbot gateway */
    send(method: string, params?: unknown, timeoutMs?: number): Promise<SendResult>;

    /** Close the connection */
    close(): Promise<boolean>;

    /** Reconnect to the Moltbot gateway */
    reconnect(): Promise<ConnectionResult>;

    /** Set event callback */
    setEventCallback(callback: ConnectionEventCallback | null): void;

    /** Set status change callback */
    setStatusCallback(callback: ConnectionStatusCallback | null): void;
}

// === Connection Wrappers ===

/**
 * Wrapper around MoltbotTunnelClient that implements MoltbotConnection
 */
class TunnelConnectionWrapper implements MoltbotConnection {
    readonly connectionType = 'tunnel' as const;
    private readonly client: MoltbotTunnelClient;
    private onDeviceToken?: (deviceToken: string) => void;

    constructor(client: MoltbotTunnelClient, onDeviceToken?: (deviceToken: string) => void) {
        this.client = client;
        this.onDeviceToken = onDeviceToken;
    }

    getStatus(): MoltbotConnectionStatus {
        return this.client.getStatus();
    }

    getMainSessionKey(): string | null {
        return this.client.getMainSessionKey();
    }

    getServerHost(): string | null {
        return this.client.getServerHost();
    }

    getPairingRequestId(): string | null {
        return this.client.getPairingRequestId();
    }

    getDeviceToken(): string | null {
        return this.client.getDeviceToken();
    }

    async connect(): Promise<ConnectionResult> {
        const result: TunnelConnectResult = await this.client.connect();

        // Notify about new device token
        if (result.deviceToken && this.onDeviceToken) {
            this.onDeviceToken(result.deviceToken);
        }

        return result;
    }

    async send(method: string, params?: unknown, timeoutMs?: number): Promise<SendResult> {
        return this.client.send(method, params, timeoutMs);
    }

    async close(): Promise<boolean> {
        return this.client.close();
    }

    async reconnect(): Promise<ConnectionResult> {
        const result = await this.client.reconnect();

        // Notify about new device token
        if (result.deviceToken && this.onDeviceToken) {
            this.onDeviceToken(result.deviceToken);
        }

        return result;
    }

    setEventCallback(callback: ConnectionEventCallback | null): void {
        this.client.setEventCallback(callback as TunnelEventCallback | null);
    }

    setStatusCallback(callback: ConnectionStatusCallback | null): void {
        this.client.setStatusCallback(callback as TunnelStatusCallback | null);
    }
}

/**
 * Wrapper around MoltbotDirectClient that implements MoltbotConnection
 */
class DirectConnectionWrapper implements MoltbotConnection {
    readonly connectionType = 'direct' as const;
    private readonly client: MoltbotDirectClient;
    private onDeviceToken?: (deviceToken: string) => void;

    constructor(client: MoltbotDirectClient, onDeviceToken?: (deviceToken: string) => void) {
        this.client = client;
        this.onDeviceToken = onDeviceToken;
    }

    getStatus(): MoltbotConnectionStatus {
        return this.client.getStatus();
    }

    getMainSessionKey(): string | null {
        return this.client.getMainSessionKey();
    }

    getServerHost(): string | null {
        return this.client.getServerHost();
    }

    getPairingRequestId(): string | null {
        return this.client.getPairingRequestId();
    }

    getDeviceToken(): string | null {
        return this.client.getDeviceToken();
    }

    async connect(): Promise<ConnectionResult> {
        const result: DirectConnectResult = await this.client.connect();

        // Notify about new device token
        if (result.deviceToken && this.onDeviceToken) {
            this.onDeviceToken(result.deviceToken);
        }

        return result;
    }

    async send(method: string, params?: unknown, timeoutMs?: number): Promise<SendResult> {
        return this.client.send(method, params, timeoutMs);
    }

    async close(): Promise<boolean> {
        return this.client.close();
    }

    async reconnect(): Promise<ConnectionResult> {
        const result = await this.client.reconnect();

        // Notify about new device token
        if (result.deviceToken && this.onDeviceToken) {
            this.onDeviceToken(result.deviceToken);
        }

        return result;
    }

    setEventCallback(callback: ConnectionEventCallback | null): void {
        this.client.setEventCallback(callback as DirectClientEventCallback | null);
    }

    setStatusCallback(callback: ConnectionStatusCallback | null): void {
        this.client.setStatusCallback(callback as DirectClientStatusCallback | null);
    }
}

// === Factory Function ===

/**
 * Error thrown when connection cannot be created due to invalid configuration
 */
export class ConnectionConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConnectionConfigError';
    }
}

/**
 * Configuration for tunnel connections (type='happy')
 */
export interface TunnelConnectionConfig {
    /** The Happy machine ID to relay through */
    machineId: string;
    /** Gateway URL (typically 'ws://localhost:18789') */
    url: string;
    /** Device token for authentication */
    token?: string;
    /** Gateway password */
    password?: string;
    /** Pairing data for device authentication */
    pairingData?: MoltbotPairingData;
}

/**
 * Configuration for direct connections (type='direct')
 */
export interface DirectConnectionConfig {
    /** Gateway URL */
    url: string;
    /** Gateway password */
    password?: string;
    /** Device token for authentication */
    token?: string;
    /** Pairing data for device authentication */
    pairingData?: MoltbotPairingData;
}

/**
 * Create a unified connection for a Moltbot machine
 *
 * Automatically chooses tunnel or direct connection based on machine type:
 * - For type='happy': creates tunnel client using the linked Happy machine
 * - For type='direct': creates direct client using the directConfig
 *
 * @param machine - The Moltbot machine configuration
 * @param options - Connection options (callbacks)
 * @returns A MoltbotConnection instance
 * @throws ConnectionConfigError if the machine configuration is invalid
 *
 * @example
 * ```typescript
 * const machine = useMoltbotMachine('machine-123');
 * if (machine) {
 *     const connection = createConnection(machine, {
 *         onStatusChange: (status, error) => {
 *             console.log('Status:', status, error);
 *         },
 *         onEvent: (event, payload) => {
 *             console.log('Event:', event, payload);
 *         },
 *         onDeviceToken: (token) => {
 *             // Save the new device token
 *         },
 *     });
 *
 *     const result = await connection.connect();
 *     if (result.ok) {
 *         const response = await connection.send('sessions.list', {});
 *         console.log('Sessions:', response.payload);
 *     }
 *
 *     await connection.close();
 * }
 * ```
 */
export function createConnection(
    machine: MoltbotMachine,
    options: ConnectionOptions = {}
): MoltbotConnection {
    const { onEvent, onStatusChange, onDeviceToken } = options;

    if (machine.type === 'happy') {
        // Tunnel connection through Happy machine
        if (!machine.happyMachineId) {
            throw new ConnectionConfigError(
                `Moltbot machine ${machine.id} is type='happy' but has no linked Happy machine`
            );
        }

        // For tunnel connections, the daemon handles the gateway URL
        // We just need to tell it where to connect
        const client = createTunnelClient({
            machineId: machine.happyMachineId,
            url: 'ws://localhost:18789', // Default Moltbot gateway port
            // Gateway auth token - read from metadata (encrypted/synced) or legacy gatewayToken field
            token: machine.metadata?.gatewayToken ?? machine.gatewayToken ?? undefined,
            pairingData: machine.pairingData ?? undefined,
            onEvent,
            onStatusChange,
        });

        return new TunnelConnectionWrapper(client, onDeviceToken);
    } else if (machine.type === 'direct') {
        // Direct connection to gateway
        if (!machine.directConfig) {
            throw new ConnectionConfigError(
                `Moltbot machine ${machine.id} is type='direct' but has no directConfig`
            );
        }

        const client = createDirectClient({
            url: machine.directConfig.url,
            password: machine.directConfig.password,
            token: machine.directConfig.token ?? machine.pairingData?.deviceToken,
            pairingData: machine.pairingData ?? undefined,
            onEvent,
            onStatusChange,
        });

        return new DirectConnectionWrapper(client, onDeviceToken);
    } else {
        throw new ConnectionConfigError(
            `Unknown machine type '${(machine as any).type}' for Moltbot machine ${machine.id}`
        );
    }
}

/**
 * Create a tunnel connection with explicit configuration
 *
 * Use this when you need more control over the tunnel configuration
 * or when creating a connection without a stored MoltbotMachine.
 */
export function createTunnelConnection(
    config: TunnelConnectionConfig,
    options: ConnectionOptions = {}
): MoltbotConnection {
    const { onEvent, onStatusChange, onDeviceToken } = options;

    const client = createTunnelClient({
        machineId: config.machineId,
        url: config.url,
        token: config.token,
        password: config.password,
        pairingData: config.pairingData,
        onEvent,
        onStatusChange,
    });

    return new TunnelConnectionWrapper(client, onDeviceToken);
}

/**
 * Create a direct connection with explicit configuration
 *
 * Use this when you need more control over the direct configuration
 * or when creating a connection without a stored MoltbotMachine.
 */
export function createDirectConnection(
    config: DirectConnectionConfig,
    options: ConnectionOptions = {}
): MoltbotConnection {
    const { onEvent, onStatusChange, onDeviceToken } = options;

    const client = createDirectClient({
        url: config.url,
        password: config.password,
        token: config.token,
        pairingData: config.pairingData,
        onEvent,
        onStatusChange,
    });

    return new DirectConnectionWrapper(client, onDeviceToken);
}

// === React Hook ===

/**
 * Hook state for useMoltbotConnection
 */
export interface UseMoltbotConnectionState {
    /** Current connection status */
    status: MoltbotConnectionStatus;
    /** Whether a connection is currently active */
    isConnected: boolean;
    /** Whether a connection is in progress */
    isConnecting: boolean;
    /** Whether pairing is required */
    isPairingRequired: boolean;
    /** Error message if any */
    error: string | null;
    /** Main session key (available after connection) */
    mainSessionKey: string | null;
    /** Server host (available after connection) */
    serverHost: string | null;
    /** Pairing request ID (available when pairing required) */
    pairingRequestId: string | null;
}

/**
 * Hook actions for useMoltbotConnection
 */
export interface UseMoltbotConnectionActions {
    /** Connect to the Moltbot gateway */
    connect: () => Promise<ConnectionResult>;
    /** Send a request to the gateway */
    send: (method: string, params?: unknown, timeoutMs?: number) => Promise<SendResult>;
    /** Close the connection */
    close: () => Promise<boolean>;
    /** Reconnect to the gateway */
    reconnect: () => Promise<ConnectionResult>;
}

/**
 * Hook return type
 */
export type UseMoltbotConnectionReturn = UseMoltbotConnectionState & UseMoltbotConnectionActions;

/**
 * Hook options for useMoltbotConnection
 */
export interface UseMoltbotConnectionOptions {
    /** Auto-connect when the hook mounts */
    autoConnect?: boolean;
    /** Callback for gateway events */
    onEvent?: ConnectionEventCallback;
    /** Callback when a new device token is received */
    onDeviceToken?: (deviceToken: string) => void;
    /** Maximum number of auto-reconnect attempts (default: 5) */
    maxRetries?: number;
    /** Initial retry delay in ms (default: 1000) */
    initialRetryDelay?: number;
    /** Maximum retry delay in ms (default: 30000) */
    maxRetryDelay?: number;
}

/**
 * React hook for easy Moltbot connection management
 *
 * Provides a unified connection interface for React components, automatically
 * handling connection lifecycle and state management.
 *
 * @param machineId - The ID of the Moltbot machine to connect to
 * @param options - Hook options
 * @returns Connection state and actions
 *
 * @example
 * ```typescript
 * function MoltbotSessionList({ machineId }: { machineId: string }) {
 *     const {
 *         status,
 *         isConnected,
 *         isConnecting,
 *         error,
 *         connect,
 *         send,
 *         close,
 *     } = useMoltbotConnection(machineId, {
 *         autoConnect: true,
 *         onEvent: (event, payload) => {
 *             console.log('Gateway event:', event, payload);
 *         },
 *     });
 *
 *     const [sessions, setSessions] = React.useState([]);
 *
 *     React.useEffect(() => {
 *         if (isConnected) {
 *             send('sessions.list', {}).then(result => {
 *                 if (result.ok) {
 *                     setSessions(result.payload as any[]);
 *                 }
 *             });
 *         }
 *     }, [isConnected, send]);
 *
 *     if (isConnecting) {
 *         return <Text>Connecting...</Text>;
 *     }
 *
 *     if (error) {
 *         return <Text>Error: {error}</Text>;
 *     }
 *
 *     return (
 *         <View>
 *             {sessions.map(session => (
 *                 <Text key={session.key}>{session.displayName}</Text>
 *             ))}
 *         </View>
 *     );
 * }
 * ```
 */
export function useMoltbotConnection(
    machineId: string,
    options: UseMoltbotConnectionOptions = {}
): UseMoltbotConnectionReturn {
    const {
        autoConnect = false,
        onEvent,
        onDeviceToken,
        maxRetries = 5,
        initialRetryDelay = 1000,
        maxRetryDelay = 30000,
    } = options;

    // Get the Moltbot machine from storage
    const machine = useMoltbotMachine(machineId);

    // For type='happy', we also need the linked Happy machine to check if it's online
    const happyMachineId = machine?.type === 'happy' ? machine.happyMachineId : null;
    const happyMachine = useMachine(happyMachineId ?? '');

    // Connection state
    const [status, setStatus] = React.useState<MoltbotConnectionStatus>('disconnected');
    const [error, setError] = React.useState<string | null>(null);
    const [mainSessionKey, setMainSessionKey] = React.useState<string | null>(null);
    const [serverHost, setServerHost] = React.useState<string | null>(null);
    const [pairingRequestId, setPairingRequestId] = React.useState<string | null>(null);

    // Connection ref
    const connectionRef = React.useRef<MoltbotConnection | null>(null);
    const mountedRef = React.useRef(true);

    // Auto-reconnect state (refs to avoid triggering effect re-runs)
    const retryCountRef = React.useRef(0);
    const retryTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    // Status change callback
    const handleStatusChange = React.useCallback((newStatus: MoltbotConnectionStatus, newError?: string) => {
        if (mountedRef.current) {
            setStatus(newStatus);
            setError(newError ?? null);

            // Reset retry count on successful connection
            if (newStatus === 'connected') {
                retryCountRef.current = 0;
            }
        }
    }, []);

    // Track machine ID to detect actual machine changes (not just object reference changes)
    const prevMachineIdRef = React.useRef<string | null>(null);

    // Create connection when machine changes
    React.useEffect(() => {
        const machineId = machine?.id ?? null;
        const machineChanged = machineId !== prevMachineIdRef.current;
        prevMachineIdRef.current = machineId;

        // Only reset retry count when machine actually changes
        if (machineChanged) {
            retryCountRef.current = 0;
            if (retryTimeoutRef.current) {
                clearTimeout(retryTimeoutRef.current);
                retryTimeoutRef.current = null;
            }
        }

        if (!machine) {
            setStatus('disconnected');
            setError('Machine not found');
            return;
        }

        // Only recreate connection when machine actually changes
        if (!machineChanged && connectionRef.current) {
            return;
        }

        // Close existing connection
        if (connectionRef.current) {
            connectionRef.current.close();
            connectionRef.current = null;
        }

        try {
            connectionRef.current = createConnection(machine, {
                onEvent,
                onStatusChange: handleStatusChange,
                onDeviceToken,
            });
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to create connection');
        }
    }, [machine, onEvent, onDeviceToken, handleStatusChange]);

    // Extract stable values for dependency array (avoid object reference changes)
    const machineType = machine?.type;
    const happyMachineActive = happyMachine?.active ?? false;

    // Auto-connect effect with exponential backoff
    React.useEffect(() => {
        if (!autoConnect || !connectionRef.current || status !== 'disconnected') {
            return;
        }

        // For tunnel connections, only auto-connect if Happy machine is online
        if (machineType === 'happy' && !happyMachineActive) {
            return;
        }

        // Check retry limit
        if (retryCountRef.current >= maxRetries) {
            console.log(`[MoltbotConnection] Max retries (${maxRetries}) reached, stopping auto-reconnect`);
            return;
        }

        // Calculate delay with exponential backoff
        const delay = retryCountRef.current === 0
            ? 0  // First attempt is immediate
            : Math.min(initialRetryDelay * Math.pow(2, retryCountRef.current - 1), maxRetryDelay);

        console.log(`[MoltbotConnection] Auto-reconnect attempt ${retryCountRef.current + 1}/${maxRetries} in ${delay}ms`);

        retryTimeoutRef.current = setTimeout(() => {
            retryTimeoutRef.current = null;
            if (mountedRef.current && connectionRef.current) {
                retryCountRef.current++;
                connectionRef.current.connect();
            }
        }, delay);

        return () => {
            if (retryTimeoutRef.current) {
                clearTimeout(retryTimeoutRef.current);
                retryTimeoutRef.current = null;
            }
        };
    }, [autoConnect, status, machineType, happyMachineActive, maxRetries, initialRetryDelay, maxRetryDelay]);

    // Cleanup on unmount
    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            if (retryTimeoutRef.current) {
                clearTimeout(retryTimeoutRef.current);
                retryTimeoutRef.current = null;
            }
            if (connectionRef.current) {
                connectionRef.current.close();
                connectionRef.current = null;
            }
        };
    }, []);

    // Actions
    const connect = React.useCallback(async (): Promise<ConnectionResult> => {
        if (!connectionRef.current) {
            return { ok: false, status: 'error', error: 'No connection available' };
        }

        const result = await connectionRef.current.connect();

        if (mountedRef.current) {
            setMainSessionKey(result.mainSessionKey ?? null);
            setServerHost(result.serverHost ?? null);
            setPairingRequestId(result.pairingRequestId ?? null);
        }

        return result;
    }, []);

    const send = React.useCallback(async (
        method: string,
        params?: unknown,
        timeoutMs?: number
    ): Promise<SendResult> => {
        if (!connectionRef.current) {
            return { ok: false, error: 'No connection available' };
        }

        return connectionRef.current.send(method, params, timeoutMs);
    }, []);

    const close = React.useCallback(async (): Promise<boolean> => {
        if (!connectionRef.current) {
            return true;
        }

        const result = await connectionRef.current.close();

        if (mountedRef.current) {
            setMainSessionKey(null);
            setServerHost(null);
            setPairingRequestId(null);
        }

        return result;
    }, []);

    const reconnect = React.useCallback(async (): Promise<ConnectionResult> => {
        if (!connectionRef.current) {
            return { ok: false, status: 'error', error: 'No connection available' };
        }

        const result = await connectionRef.current.reconnect();

        if (mountedRef.current) {
            setMainSessionKey(result.mainSessionKey ?? null);
            setServerHost(result.serverHost ?? null);
            setPairingRequestId(result.pairingRequestId ?? null);
        }

        return result;
    }, []);

    return {
        // State
        status,
        isConnected: status === 'connected',
        isConnecting: status === 'connecting',
        isPairingRequired: status === 'pairing_required',
        error,
        mainSessionKey,
        serverHost,
        pairingRequestId,
        // Actions
        connect,
        send,
        close,
        reconnect,
    };
}

// === Exports ===

export type {
    MoltbotMachine,
    MoltbotConnectionStatus,
    MoltbotPairingData,
};
