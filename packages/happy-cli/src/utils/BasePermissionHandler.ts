/**
 * Base Permission Handler
 *
 * Abstract base class for permission handlers that manage tool approval requests.
 * Shared by Codex and Gemini permission handlers.
 *
 * @module BasePermissionHandler
 */

import { logger } from "@/ui/logger";
import { RpcHandlerManager } from "@/api/rpc/RpcHandlerManager";
import { AgentState } from "@/api/types";

/**
 * Permission response from the mobile app.
 */
export interface PermissionResponse {
    id: string;
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

/**
 * Pending permission request stored while awaiting user response.
 */
export interface PendingRequest {
    resolve: (value: PermissionResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    input: unknown;
}

/**
 * Result of a permission request.
 */
export interface PermissionResult {
    decision: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

/**
 * Dependencies required by BasePermissionHandler.
 * Can be satisfied by ApiSessionClient (legacy) or by passing SyncBridge-based deps directly.
 */
export interface PermissionHandlerDeps {
    rpcHandlerManager: RpcHandlerManager;
    updateAgentState: (handler: (state: AgentState) => AgentState) => void;
    sendPermissionRequest?: (request: { callID: string; tool: string; patterns: string[]; input: Record<string, unknown> }) => Promise<void>;
}

/**
 * Abstract base class for permission handlers.
 *
 * Subclasses must implement:
 * - `getLogPrefix()` - returns the log prefix (e.g., '[Codex]')
 */
export abstract class BasePermissionHandler {
    protected pendingRequests = new Map<string, PendingRequest>();
    protected deps: PermissionHandlerDeps;
    private isResetting = false;

    /**
     * Returns the log prefix for this handler.
     */
    protected abstract getLogPrefix(): string;

    constructor(deps: PermissionHandlerDeps) {
        this.deps = deps;
        this.setupRpcHandler();
    }

    /**
     * Apply a permission decision that arrived over SyncNode instead of RPC.
     */
    handleSyncDecision(response: PermissionResponse): void {
        this.applyPermissionResponse(response);
    }

    /**
     * Update the deps reference (used after offline reconnection swaps sessions).
     * This is critical for avoiding stale references after onSessionSwap.
     */
    updateDeps(newDeps: PermissionHandlerDeps): void {
        logger.debug(`${this.getLogPrefix()} Deps reference updated`);
        this.deps = newDeps;
        // Re-setup RPC handler with new deps
        this.setupRpcHandler();
    }

    /**
     * Setup RPC handler for permission responses.
     */
    protected setupRpcHandler(): void {
        this.deps.rpcHandlerManager.registerHandler<PermissionResponse, void>(
            'permission',
            async (response) => {
                this.applyPermissionResponse(response);
            }
        );
    }

    private applyPermissionResponse(response: PermissionResponse): void {
        const pending = this.pendingRequests.get(response.id);
        if (!pending) {
            logger.debug(`${this.getLogPrefix()} Permission request not found or already resolved`);
            return;
        }

        this.pendingRequests.delete(response.id);

        const result: PermissionResult = response.approved
            ? { decision: response.decision === 'approved_for_session' ? 'approved_for_session' : 'approved' }
            : { decision: response.decision === 'denied' ? 'denied' : 'abort' };

        pending.resolve(result);

        this.deps.updateAgentState((currentState) => {
            const request = currentState.requests?.[response.id];
            if (!request) return currentState;

            const { [response.id]: _, ...remainingRequests } = currentState.requests || {};

            return {
                ...currentState,
                requests: remainingRequests,
                completedRequests: {
                    ...currentState.completedRequests,
                    [response.id]: {
                        ...request,
                        completedAt: Date.now(),
                        status: response.approved ? 'approved' : 'denied',
                        decision: result.decision,
                    },
                },
            } satisfies AgentState;
        });

        logger.debug(`${this.getLogPrefix()} Permission ${response.approved ? 'approved' : 'denied'} for ${pending.toolName}`);
    }

    /**
     * Add a pending request to the agent state.
     */
    protected addPendingRequestToState(toolCallId: string, toolName: string, input: unknown): void {
        this.deps.updateAgentState((currentState) => ({
            ...currentState,
            requests: {
                ...currentState.requests,
                [toolCallId]: {
                    tool: toolName,
                    arguments: input,
                    createdAt: Date.now()
                }
            }
        }));

        const normalizedInput = (input && typeof input === 'object')
            ? input as Record<string, unknown>
            : {};
        this.deps.sendPermissionRequest?.({
            callID: toolCallId,
            tool: toolName,
            patterns: this.extractPatterns(toolName, normalizedInput),
            input: normalizedInput,
        }).catch((error) => {
            logger.debug(`${this.getLogPrefix()} Failed to send permission-request control message`, error);
        });
    }

    /**
     * Abort all pending permission requests.
     * Unlike reset(), this resolves (not rejects) pending promises with { decision: 'abort' },
     * causing the approval response to send 'cancel' to the provider. This is used when the
     * user presses the abort/stop button — it unblocks any pending tool approval so the provider
     * can process the turn cancellation.
     */
    abortAll(): void {
        const pendingSnapshot = Array.from(this.pendingRequests.entries());
        if (pendingSnapshot.length === 0) return;

        this.pendingRequests.clear();

        for (const [id, pending] of pendingSnapshot) {
            try {
                pending.resolve({ decision: 'abort' });
            } catch (err) {
                logger.debug(`${this.getLogPrefix()} Error resolving aborted request ${id}:`, err);
            }
        }

        // Move pending requests to completed as canceled in agent state
        this.deps.updateAgentState((currentState) => {
            const pendingRequests = currentState.requests || {};
            const completedRequests = { ...currentState.completedRequests };

            for (const [id, request] of Object.entries(pendingRequests)) {
                completedRequests[id] = {
                    ...request,
                    completedAt: Date.now(),
                    status: 'canceled',
                    reason: 'Aborted by user'
                };
            }

            return {
                ...currentState,
                requests: {},
                completedRequests
            };
        });

        logger.debug(`${this.getLogPrefix()} Aborted ${pendingSnapshot.length} pending permission(s)`);
    }

    /**
     * Reset state for new sessions.
     * This method is idempotent - safe to call multiple times.
     */
    reset(): void {
        // Guard against re-entrant/concurrent resets
        if (this.isResetting) {
            logger.debug(`${this.getLogPrefix()} Reset already in progress, skipping`);
            return;
        }
        this.isResetting = true;

        try {
            // Snapshot pending requests to avoid Map mutation during iteration
            const pendingSnapshot = Array.from(this.pendingRequests.entries());
            this.pendingRequests.clear(); // Clear immediately to prevent new entries being processed

            // Reject all pending requests from snapshot
            for (const [id, pending] of pendingSnapshot) {
                try {
                    pending.reject(new Error('Session reset'));
                } catch (err) {
                    logger.debug(`${this.getLogPrefix()} Error rejecting pending request ${id}:`, err);
                }
            }

            // Clear requests in agent state
            this.deps.updateAgentState((currentState) => {
                const pendingRequests = currentState.requests || {};
                const completedRequests = { ...currentState.completedRequests };

                // Move all pending to completed as canceled
                for (const [id, request] of Object.entries(pendingRequests)) {
                    completedRequests[id] = {
                        ...request,
                        completedAt: Date.now(),
                        status: 'canceled',
                        reason: 'Session reset'
                    };
                }

                return {
                    ...currentState,
                    requests: {},
                    completedRequests
                };
            });

            logger.debug(`${this.getLogPrefix()} Permission handler reset`);
        } finally {
            this.isResetting = false;
        }
    }

    private extractPatterns(toolName: string, input: Record<string, unknown>): string[] {
        if (toolName === 'Bash' && typeof input.command === 'string') {
            return [input.command];
        }
        for (const key of ['file_path', 'path', 'pattern', 'command']) {
            const value = input[key];
            if (typeof value === 'string' && value.length > 0) {
                return [value];
            }
        }
        return ['*'];
    }
}
