/**
 * Codex Permission Handler
 *
 * Handles tool permission requests and responses for Codex sessions.
 * Extends BasePermissionHandler with Codex-specific configuration.
 */

import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { PushNotificationClient } from "@/api/pushNotifications";
import type { PermissionMode } from '@/api/types';
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
    private currentPermissionMode: PermissionMode = 'default';

    constructor(session: ApiSessionClient, pushClient: PushNotificationClient) {
        super(session, pushClient);
    }

    protected getLogPrefix(): string {
        return '[Codex]';
    }

    protected getAgentName(): string {
        return 'Codex';
    }

    setPermissionMode(mode: PermissionMode): void {
        this.currentPermissionMode = mode;
        logger.debug(`${this.getLogPrefix()} Permission mode set to: ${mode}`);
    }

    private shouldAutoApprove(toolName: string, toolCallId: string): boolean {
        const alwaysAutoApproveNames = ['change_title', 'happy__change_title', 'preview_html', 'happy__preview_html', 'CodexReasoning', 'think', 'save_memory'];
        const alwaysAutoApproveIds = ['change_title', 'preview_html', 'save_memory'];

        if (alwaysAutoApproveNames.some(name => toolName.toLowerCase().includes(name.toLowerCase()))) {
            return true;
        }
        if (alwaysAutoApproveIds.some(id => toolCallId.toLowerCase().includes(id.toLowerCase()))) {
            return true;
        }

        switch (this.currentPermissionMode) {
            case 'yolo':
                return true;
            case 'safe-yolo':
                return true;
            case 'read-only': {
                const writeTools = ['write', 'edit', 'create', 'delete', 'patch', 'fs-edit'];
                return !writeTools.some(wt => toolName.toLowerCase().includes(wt));
            }
            case 'default':
            default:
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
        if (this.shouldAutoApprove(toolName, toolCallId)) {
            logger.debug(`${this.getLogPrefix()} Auto-approving tool ${toolName} (${toolCallId}) in ${this.currentPermissionMode} mode`);

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