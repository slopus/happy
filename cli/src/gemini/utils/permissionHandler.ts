/**
 * Permission Handler for Gemini tool approval integration
 * 
 * Handles tool permission requests and responses for Gemini ACP sessions.
 * Similar to Codex's permission handler, but adapted for ACP protocol.
 */

import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { AgentState } from "@/api/types";
import type { PermissionMode } from '@/gemini/types';

interface PermissionResponse {
    id: string;
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

interface PendingRequest {
    resolve: (value: PermissionResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    input: unknown;
}

interface PermissionResult {
    decision: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

export class GeminiPermissionHandler {
    private pendingRequests = new Map<string, PendingRequest>();
    private session: ApiSessionClient;
    private currentPermissionMode: PermissionMode = 'default';

    constructor(session: ApiSessionClient) {
        this.session = session;
        this.setupRpcHandler();
    }

    /**
     * Set the current permission mode
     * This affects how tool calls are automatically approved/denied
     */
    setPermissionMode(mode: PermissionMode): void {
        this.currentPermissionMode = mode;
        logger.debug(`[Gemini] Permission mode set to: ${mode}`);
    }

    /**
     * Check if a tool should be auto-approved based on permission mode
     */
    private shouldAutoApprove(toolName: string, toolCallId: string, input: unknown): boolean {
        // Always auto-approve these tools regardless of permission mode:
        // - change_title: Changing chat title is safe and should be automatic
        // - GeminiReasoning: Reasoning is just display of thinking process, not an action
        // - think: Thinking/saving memories is safe
        // - save_memory: Saving memories is safe
        const alwaysAutoApproveNames = ['change_title', 'happy__change_title', 'GeminiReasoning', 'CodexReasoning', 'think', 'save_memory'];
        const alwaysAutoApproveIds = ['change_title', 'save_memory'];
        
        // Check by tool name
        if (alwaysAutoApproveNames.some(name => toolName.toLowerCase().includes(name.toLowerCase()))) {
            return true;
        }
        
        // Check by toolCallId (Gemini CLI may send change_title as "other" but toolCallId contains "change_title")
        if (alwaysAutoApproveIds.some(id => toolCallId.toLowerCase().includes(id.toLowerCase()))) {
            return true;
        }
        
        switch (this.currentPermissionMode) {
            case 'yolo':
                // Auto-approve everything in yolo mode
                return true;
            case 'safe-yolo':
                // Auto-approve read-only operations, ask for write operations
                // For now, we'll auto-approve everything (can be enhanced later)
                return true;
            case 'read-only':
                // Deny all write operations - only allow read operations
                // Check if tool is a write operation (can be enhanced with tool metadata)
                const writeTools = ['write', 'edit', 'create', 'delete', 'patch', 'fs-edit'];
                const isWriteTool = writeTools.some(wt => toolName.toLowerCase().includes(wt));
                return !isWriteTool;
            case 'default':
            default:
                // Default mode - always ask for permission (except for always-auto-approve tools above)
                return false;
        }
    }

    /**
     * Handle a tool permission request
     * @param toolCallId - The unique ID of the tool call
     * @param toolName - The name of the tool being called
     * @param input - The input parameters for the tool
     * @returns Promise resolving to permission result
     */
    async handleToolCall(
        toolCallId: string,
        toolName: string,
        input: unknown
    ): Promise<PermissionResult> {
        // Check if we should auto-approve based on permission mode
        // Pass toolCallId to check by ID (e.g., change_title-* even if toolName is "other")
        if (this.shouldAutoApprove(toolName, toolCallId, input)) {
            logger.debug(`[Gemini] Auto-approving tool ${toolName} (${toolCallId}) in ${this.currentPermissionMode} mode`);
            
            // Update agent state with auto-approved request
            this.session.updateAgentState((currentState) => ({
                ...currentState,
                completedRequests: {
                    ...currentState.completedRequests,
                    [toolCallId]: {
                        tool: toolName,
                        arguments: input,
                        createdAt: Date.now(),
                        completedAt: Date.now(),
                        status: 'approved',
                        decision: this.currentPermissionMode === 'yolo' ? 'approved_for_session' : 'approved'
                    }
                }
            }));

            return {
                decision: this.currentPermissionMode === 'yolo' ? 'approved_for_session' : 'approved'
            };
        }

        // Otherwise, ask for permission (same as before)
        return new Promise<PermissionResult>((resolve, reject) => {
            // Store the pending request
            this.pendingRequests.set(toolCallId, {
                resolve,
                reject,
                toolName,
                input
            });

            // Update agent state with pending request
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

            logger.debug(`[Gemini] Permission request sent for tool: ${toolName} (${toolCallId}) in ${this.currentPermissionMode} mode`);
        });
    }

    /**
     * Setup RPC handler for permission responses
     */
    private setupRpcHandler(): void {
        this.session.rpcHandlerManager.registerHandler<PermissionResponse, void>(
            'permission',
            async (response) => {
                const pending = this.pendingRequests.get(response.id);
                if (!pending) {
                    logger.debug('[Gemini] Permission request not found or already resolved');
                    return;
                }

                // Remove from pending
                this.pendingRequests.delete(response.id);

                // Resolve the permission request
                const result: PermissionResult = response.approved
                    ? { decision: response.decision === 'approved_for_session' ? 'approved_for_session' : 'approved' }
                    : { decision: response.decision === 'denied' ? 'denied' : 'abort' };

                pending.resolve(result);

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
                                decision: result.decision
                            }
                        }
                    } satisfies AgentState;
                    return res;
                });

                logger.debug(`[Gemini] Permission ${response.approved ? 'approved' : 'denied'} for ${pending.toolName}`);
            }
        );
    }

    /**
     * Reset state for new sessions
     */
    reset(): void {
        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests.entries()) {
            pending.reject(new Error('Session reset'));
        }
        this.pendingRequests.clear();

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

        logger.debug('[Gemini] Permission handler reset');
    }
}

