import type { RpcLatencySnapshot } from '@slopus/happy-wire';

/**
 * Common RPC types and interfaces for both session and machine clients
 */

/**
 * Generic RPC handler function type
 * @template TRequest - The request data type
 * @template TResponse - The response data type
 */
export type RpcHandler<TRequest = any, TResponse = any> = (
    data: TRequest
) => TResponse | Promise<TResponse>;

/**
 * Map of method names to their handlers
 */
export type RpcHandlerMap = Map<string, RpcHandler>;

/**
 * RPC request data from server
 */
export interface RpcRequest {
    method: string;
    params: string; // Base64 encoded encrypted params
    rpcLatency?: unknown; // Optional versioned diagnostics, never authority.
}

/**
 * RPC response callback
 */
export type RpcResponseCallback = (response: string | { result: string; rpcLatency: RpcLatencySnapshot }) => void;

/**
 * Configuration for RPC handler manager
 */
export interface RpcHandlerConfig {
    scopePrefix: string;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    logger?: (message: string, data?: any) => void;
    /**
     * aplus-dev-studio specs/e2ee-machine-control-boundary R2/R3 — a second
     * key (AES-256-GCM) the server holds instead of the machine key. Requests
     * it opens run only methods `allows` accepts, and are answered with it.
     */
    serverLane?: ServerLaneConfig;
    /**
     * aplus-dev-studio specs/e2ee-machine-control-boundary R19 — strict machine
     * control: a customer-lane request must be bound (R18). An unbound one is
     * refused before any handler runs.
     */
    requireBoundRequests?: boolean;
    /**
     * How many bound requests one scope remembers within the time window (default 10,000).
     * When full, strict refuses new ones and compat forgets its oldest.
     */
    maxBoundRequestsInWindow?: number;
}

export interface ServerLaneConfig {
    encryptionKey: Uint8Array;
    /** Receives the method name without the scope prefix. */
    allows: (method: string) => boolean;
}

/**
 * Result of RPC handler execution
 */
export type RpcHandlerResult<T = any> =
    | { success: true; data: T }
    | { success: false; error: string };