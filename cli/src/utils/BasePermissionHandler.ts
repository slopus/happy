/**
 * Base Permission Handler
 *
 * Abstract base class for permission handlers that manage tool approval requests.
 * Shared by Codex and Gemini permission handlers.
 *
 * @module BasePermissionHandler
 */

import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { AgentState } from "@/api/types";
import { isToolAllowedForSession, makeToolIdentifier } from "@/utils/permissionToolIdentifier";

/**
 * Permission response from the mobile app.
 */
export interface PermissionResponse {
    id: string;
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
    // When the user chooses "don't ask again (session)", the UI may send a tool allowlist.
    allowedTools?: string[];
    allowTools?: string[]; // legacy alias
    execPolicyAmendment?: {
        command: string[];
    };
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
    decision: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
    execPolicyAmendment?: {
        command: string[];
    };
}

/**
 * Abstract base class for permission handlers.
 *
 * Subclasses must implement:
 * - `getLogPrefix()` - returns the log prefix (e.g., '[Codex]')
 */
export abstract class BasePermissionHandler {
    protected pendingRequests = new Map<string, PendingRequest>();
    protected session: ApiSessionClient;
    private isResetting = false;
    private allowedToolIdentifiers = new Set<string>();
    private readonly onAbortRequested: (() => void | Promise<void>) | null;

    /**
     * Returns the log prefix for this handler.
     */
    protected abstract getLogPrefix(): string;

    constructor(
        session: ApiSessionClient,
        opts?: {
            onAbortRequested?: (() => void | Promise<void>) | null;
        }
    ) {
        this.session = session;
        this.onAbortRequested = typeof opts?.onAbortRequested === 'function' ? opts.onAbortRequested : null;
        this.setupRpcHandler();
        this.seedAllowedToolsFromAgentState();
    }

    /**
     * Update the session reference (used after offline reconnection swaps sessions).
     * This is critical for avoiding stale session references after onSessionSwap.
     */
    updateSession(newSession: ApiSessionClient): void {
        logger.debug(`${this.getLogPrefix()} Session reference updated`);
        this.session = newSession;
        // Re-setup RPC handler with new session
        this.setupRpcHandler();
        this.seedAllowedToolsFromAgentState();
    }

    private seedAllowedToolsFromAgentState(): void {
        try {
            const snapshot = this.session.getAgentStateSnapshot?.() ?? null;
            const completed = snapshot?.completedRequests;
            if (!completed) return;

            for (const entry of Object.values(completed)) {
                if (!entry || entry.status !== 'approved') continue;
                // Legacy sessions may still have `allowTools`; prefer canonical `allowedTools`.
                const list = (entry as any).allowedTools ?? (entry as any).allowTools;
                if (!Array.isArray(list)) continue;
                for (const item of list) {
                    if (typeof item === 'string' && item.trim().length > 0) {
                        this.allowedToolIdentifiers.add(item.trim());
                    }
                }
            }
        } catch (error) {
            logger.debug(`${this.getLogPrefix()} Failed to seed allowlist from agentState`, error);
        }
    }

    /**
     * Setup RPC handler for permission responses.
     */
    protected setupRpcHandler(): void {
        this.session.rpcHandlerManager.registerHandler<PermissionResponse, void>(
            'permission',
            async (response) => {
                const pending = this.pendingRequests.get(response.id);
                if (!pending) {
                    logger.debug(`${this.getLogPrefix()} Permission request not found or already resolved`);
                    return;
                }

                // Remove from pending
                this.pendingRequests.delete(response.id);

                // Resolve the permission request
                let result: PermissionResult;

                if (response.approved) {
                    const wantsExecpolicyAmendment = response.decision === 'approved_execpolicy_amendment'
                        && Boolean(response.execPolicyAmendment?.command?.length);

                    if (wantsExecpolicyAmendment) {
                        result = {
                            decision: 'approved_execpolicy_amendment',
                            execPolicyAmendment: response.execPolicyAmendment,
                        };
                    } else if (response.decision === 'approved_for_session') {
                        result = { decision: 'approved_for_session' };
                    } else {
                        result = { decision: 'approved' };
                    }
                } else {
                    result = { decision: response.decision === 'denied' ? 'denied' : 'abort' };
                }

                // Per-session allowlist: if user chooses "approved_for_session", remember this tool (and for
                // shell/exec tools, remember the exact command) so future prompts can auto-approve.
                const responseAllowedTools = response.allowedTools ?? response.allowTools;
                if (response.approved) {
                    if (Array.isArray(responseAllowedTools)) {
                        for (const item of responseAllowedTools) {
                            if (typeof item === 'string' && item.trim().length > 0) {
                                this.allowedToolIdentifiers.add(item.trim());
                            }
                        }
                    } else if (result.decision === 'approved_for_session') {
                        this.allowedToolIdentifiers.add(makeToolIdentifier(pending.toolName, pending.input));
                    }
                }

                pending.resolve(result);

                if (result.decision === 'abort') {
                    try {
                        const cb = this.onAbortRequested;
                        if (cb) {
                            Promise.resolve(cb()).catch((error) => {
                                logger.debug(`${this.getLogPrefix()} onAbortRequested failed (non-fatal)`, error);
                            });
                        }
                    } catch (error) {
                        logger.debug(`${this.getLogPrefix()} onAbortRequested threw (non-fatal)`, error);
                    }
                }

                const derivedAllowTools =
                    Array.isArray(responseAllowedTools)
                        ? responseAllowedTools
                        : (result.decision === 'approved_for_session'
                            ? [makeToolIdentifier(pending.toolName, pending.input)]
                            : undefined);

                // Move request to completed in agent state
                this.session.updateAgentState((currentState) => {
                    const request = currentState.requests?.[response.id];
                    if (!request) return currentState;

                    const { [response.id]: _, ...remainingRequests } = currentState.requests || {};

                    let res = {
                        ...currentState,
                        requests: remainingRequests,
                        completedRequests: {
                            ...currentState.completedRequests,
                            [response.id]: {
                                ...request,
                                completedAt: Date.now(),
                                status: response.approved ? 'approved' : 'denied',
                                decision: result.decision,
                                // Persist allowlist for the UI and for future CLI reconnects.
                                ...(derivedAllowTools ? { allowedTools: derivedAllowTools } : null),
                            }
                        }
                    } satisfies AgentState;
                    return res;
                });

                logger.debug(`${this.getLogPrefix()} Permission ${response.approved ? 'approved' : 'denied'} for ${pending.toolName}`);
            }
        );
    }

    protected isAllowedForSession(toolName: string, input: unknown): boolean {
        return isToolAllowedForSession(this.allowedToolIdentifiers, toolName, input);
    }

    protected recordAutoDecision(
        toolCallId: string,
        toolName: string,
        input: unknown,
        decision: PermissionResult['decision']
    ): void {
        const allowedTools = decision === 'approved_for_session'
            ? [makeToolIdentifier(toolName, input)]
            : undefined;
        this.session.updateAgentState((currentState) => ({
            ...currentState,
            completedRequests: {
                ...currentState.completedRequests,
                [toolCallId]: {
                    tool: toolName,
                    arguments: input,
                    createdAt: Date.now(),
                    completedAt: Date.now(),
                    status: decision === 'denied' || decision === 'abort' ? 'denied' : 'approved',
                    decision,
                    ...(allowedTools ? { allowedTools } : null),
                },
            },
        }));
    }

    /**
     * Add a pending request to the agent state.
     */
    protected addPendingRequestToState(toolCallId: string, toolName: string, input: unknown): void {
        this.session.updateAgentState((currentState) => ({
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
            this.session.updateAgentState((currentState) => {
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

            this.allowedToolIdentifiers.clear();
            logger.debug(`${this.getLogPrefix()} Permission handler reset`);
        } finally {
            this.isResetting = false;
        }
    }
}
