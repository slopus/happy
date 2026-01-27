/**
 * Codex Permission Handler
 *
 * Handles tool permission requests and responses for Codex sessions.
 * Extends BasePermissionHandler with Codex-specific configuration.
 */

import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import {
    BasePermissionHandler,
    PermissionResult,
    PendingRequest
} from '@/agent/permissions/BasePermissionHandler';

// Re-export types for backwards compatibility
export type { PermissionResult, PendingRequest };

/**
 * Codex-specific permission handler.
 */
export class CodexPermissionHandler extends BasePermissionHandler {
    constructor(
        session: ApiSessionClient,
        opts?: { onAbortRequested?: (() => void | Promise<void>) | null },
    ) {
        super(session, {
            ...opts,
            toolTrace: { protocol: 'codex', provider: 'codex' },
        });
    }

    protected getLogPrefix(): string {
        return '[Codex]';
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
        // Respect user "don't ask again for session" choices captured via our permission UI.
        if (this.isAllowedForSession(toolName, input)) {
            logger.debug(`${this.getLogPrefix()} Auto-approving (allowed for session) tool ${toolName} (${toolCallId})`);
            this.recordAutoDecision(toolCallId, toolName, input, 'approved_for_session');
            return { decision: 'approved_for_session' };
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
