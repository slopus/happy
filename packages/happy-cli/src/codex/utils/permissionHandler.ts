/**
 * Codex Permission Handler
 *
 * Handles tool permission requests and responses for Codex sessions.
 * Extends BasePermissionHandler with Codex-specific configuration.
 */

import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import type { AgentState } from "@/api/types";
import {
    BasePermissionHandler,
    PermissionResult,
    PendingRequest
} from '@/utils/BasePermissionHandler';

// Re-export types for backwards compatibility
export type { PermissionResult, PendingRequest };

/**
 * Codex-specific permission handler.
 */
export class CodexPermissionHandler extends BasePermissionHandler {
    private static readonly ALWAYS_AUTO_APPROVE_NAMES = [
        'change_title',
    ];

    private static readonly ALWAYS_AUTO_APPROVE_IDS = [
        'change_title',
    ];

    constructor(session: ApiSessionClient) {
        super(session);
    }

    protected getLogPrefix(): string {
        return '[Codex]';
    }

    private shouldAutoApprove(toolName: string, toolCallId: string): boolean {
        if (CodexPermissionHandler.ALWAYS_AUTO_APPROVE_NAMES.some((name) => toolName.toLowerCase().includes(name.toLowerCase()))) {
            return true;
        }

        if (CodexPermissionHandler.ALWAYS_AUTO_APPROVE_IDS.some((id) => toolCallId.toLowerCase().includes(id.toLowerCase()))) {
            return true;
        }

        return false;
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
        if (this.shouldAutoApprove(toolName, toolCallId)) {
            logger.debug(`${this.getLogPrefix()} Auto-approving tool ${toolName} (${toolCallId})`);

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
                        decision: 'approved',
                    },
                },
            } satisfies AgentState));

            return { decision: 'approved' };
        }

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

            logger.debug(`${this.getLogPrefix()} Permission request sent for tool: ${toolName} (${toolCallId})`);
        });
    }
}
