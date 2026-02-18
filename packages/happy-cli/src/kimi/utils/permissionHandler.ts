/**
 * Kimi Permission Handler
 *
 * Handles tool permission requests and responses for Kimi ACP sessions.
 * Extends BasePermissionHandler with Kimi-specific permission mode logic.
 */

import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import type { PermissionMode } from '@/api/types';
import {
    BasePermissionHandler,
    PermissionResult,
    PendingRequest
} from '@/utils/BasePermissionHandler';

// Re-export types for backwards compatibility
export type { PermissionResult, PendingRequest };

/**
 * Kimi-specific permission handler with permission mode support.
 */
export class KimiPermissionHandler extends BasePermissionHandler {
    private currentPermissionMode: PermissionMode = 'default';

    constructor(session: ApiSessionClient) {
        super(session);
    }

    protected getLogPrefix(): string {
        return '[Kimi]';
    }

    /**
     * Update session reference (override for type visibility)
     */
    updateSession(newSession: ApiSessionClient): void {
        super.updateSession(newSession);
    }

    /**
     * Set the current permission mode.
     * This affects how tool calls are automatically approved/denied.
     */
    setPermissionMode(mode: PermissionMode): void {
        this.currentPermissionMode = mode;
        logger.debug(`${this.getLogPrefix()} Permission mode set to: ${mode}`);
    }

    /**
     * Check if a tool should be auto-approved based on permission mode
     */
    private shouldAutoApprove(toolName: string, toolCallId: string, _input: unknown): boolean {
        // Always auto-approve these tools regardless of permission mode:
        // - change_title: Changing chat title is safe and should be automatic
        // - KimiReasoning: Reasoning is just display of thinking process, not an action
        // - think: Thinking is safe
        // - save_memory: Saving memories is safe
        const alwaysAutoApproveNames = ['change_title', 'happy__change_title', 'KimiReasoning', 'CodexReasoning', 'think', 'save_memory'];
        const alwaysAutoApproveIds = ['change_title', 'save_memory'];

        // Check by tool name
        if (alwaysAutoApproveNames.some(name => toolName.toLowerCase().includes(name.toLowerCase()))) {
            return true;
        }

        // Check by toolCallId (Kimi CLI may send change_title as "other" but toolCallId contains "change_title")
        if (alwaysAutoApproveIds.some(id => toolCallId.toLowerCase().includes(id.toLowerCase()))) {
            return true;
        }

        switch (this.currentPermissionMode) {
            case 'yolo':
                // Auto-approve everything in yolo mode
                return true;
            case 'safe-yolo':
                // Auto-approve read-only operations, ask for write operations
                return true;
            case 'read-only': {
                // Deny all write operations - only allow read operations
                const writeTools = ['write', 'edit', 'create', 'delete', 'patch', 'fs-edit'];
                const isWriteTool = writeTools.some(wt => toolName.toLowerCase().includes(wt));
                return !isWriteTool;
            }
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
        if (this.shouldAutoApprove(toolName, toolCallId, input)) {
            logger.debug(`${this.getLogPrefix()} Auto-approving tool ${toolName} (${toolCallId}) in ${this.currentPermissionMode} mode`);

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

        // Otherwise, ask for permission
        return new Promise<PermissionResult>((resolve, reject) => {
            // Store the pending request
            this.pendingRequests.set(toolCallId, {
                resolve,
                reject,
                toolName,
                input
            });

            // Update agent state with pending request
            this.addPendingRequestToState(toolCallId, toolName, input);

            logger.debug(`${this.getLogPrefix()} Permission request sent for tool: ${toolName} (${toolCallId}) in ${this.currentPermissionMode} mode`);
        });
    }
}
