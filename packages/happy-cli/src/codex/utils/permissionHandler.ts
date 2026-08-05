/**
 * Codex Permission Handler
 *
 * Handles tool permission requests and responses for Codex sessions.
 * Extends BasePermissionHandler with Codex-specific configuration.
 */

import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import type { AgentState, Metadata, PermissionMode } from '@/api/types';
import {
    BasePermissionHandler,
    PermissionResult,
    PendingRequest
} from '@/utils/BasePermissionHandler';

// Re-export types for backwards compatibility
export type { PermissionResult, PendingRequest };

export type CodexPermissionNotification = {
    kind: 'permission';
    metadata: Metadata | null | undefined;
    data: {
        sessionId: string;
        requestId: string;
        tool: string;
        type: 'permission_request';
        provider: 'codex';
    };
};

type CodexPermissionNotifier = (notification: CodexPermissionNotification) => void;

/**
 * Codex-specific permission handler.
 */
export class CodexPermissionHandler extends BasePermissionHandler {
    private currentPermissionMode: PermissionMode = 'default';

    // Exact first-party Happy tool names that should always be auto-approved.
    // Include the bare form (used by Codex elicitation messages like
    // `tool "change_title"`) and the MCP-qualified form for defense in depth.
    private static readonly ALWAYS_AUTO_APPROVE_NAMES: ReadonlySet<string> = new Set([
        'change_title',
        'mcp__happy__change_title',
        'archive_session',
        'mcp__happy__archive_session',
        'send_image',
        'mcp__happy__send_image',
        'send_file',
        'mcp__happy__send_file',
    ]);

    // Tool-call IDs that should auto-approve when they exactly match one of
    // these values or start with `<name>-` (e.g. `change_title-1765385846663`).
    // Substring matching was a bypass vector — any tool whose ID happened to
    // contain `change_title` as a substring would be silently approved.
    private static readonly ALWAYS_AUTO_APPROVE_ID_PREFIXES: readonly string[] = [
        'change_title',
        'archive_session',
        'send_image',
        'send_file',
    ];

    constructor(
        session: ApiSessionClient,
        private readonly notifyPermission?: CodexPermissionNotifier
    ) {
        super(session);
    }

    protected getLogPrefix(): string {
        return '[Codex]';
    }

    setPermissionMode(mode: PermissionMode): void {
        const previousMode = this.currentPermissionMode;
        this.currentPermissionMode = mode;
        logger.debug(`${this.getLogPrefix()} Permission mode set to: ${mode}`);

        if (mode === 'yolo' && previousMode !== 'yolo') {
            this.approveAllPending('approved_for_session');
        }
    }

    private shouldAutoApprove(toolName: string, toolCallId: string): boolean {
        if (this.currentPermissionMode === 'yolo') {
            return true;
        }

        if (CodexPermissionHandler.ALWAYS_AUTO_APPROVE_NAMES.has(toolName)) {
            return true;
        }

        for (const prefix of CodexPermissionHandler.ALWAYS_AUTO_APPROVE_ID_PREFIXES) {
            if (toolCallId === prefix || toolCallId.startsWith(`${prefix}-`)) {
                return true;
            }
        }

        return false;
    }

    private notifyPendingPermission(toolCallId: string, toolName: string): void {
        if (!this.notifyPermission) {
            return;
        }

        try {
            this.notifyPermission({
                kind: 'permission',
                metadata: this.session.getMetadata(),
                data: {
                    sessionId: this.session.sessionId,
                    requestId: toolCallId,
                    tool: toolName,
                    type: 'permission_request',
                    provider: 'codex',
                },
            });
        } catch (error) {
            logger.debug(`${this.getLogPrefix()} Failed to send permission notification`, error);
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
            const decision = this.currentPermissionMode === 'yolo' ? 'approved_for_session' : 'approved';
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
                        decision,
                    },
                },
            } satisfies AgentState));

            return { decision };
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
            this.notifyPendingPermission(toolCallId, toolName);

            logger.debug(`${this.getLogPrefix()} Permission request sent for tool: ${toolName} (${toolCallId})`);
        });
    }
}
