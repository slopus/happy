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
    PendingRequest,
    type PendingSettlementReason
} from '@/utils/BasePermissionHandler';
import {
    buildChannelApprovalObservation,
    channelApprovalEvent,
    channelApprovalWithdrawnEvent,
} from '@/channel/channelApprovalEvent';
import type { ChannelPermissionBinding } from '@/channel/channelPermissionBinding';
import { createEnvelope } from '@slopus/happy-wire';

// Re-export types for backwards compatibility
export type { PermissionResult, PendingRequest };

/**
 * Codex-specific permission handler.
 */
export class CodexPermissionHandler extends BasePermissionHandler {
    private shutdownClosed = false;

    /** A launch shutdown is permanent; ordinary user abortAll remains reusable. */
    closeForShutdown(): void {
        this.shutdownClosed = true;
        this.abortAll('Session shutting down');
    }

    // Exact tool names that should always be auto-approved. Include the bare
    // form (used by Codex elicitation messages like `tool "change_title"`)
    // and the MCP-qualified form for defense in depth.
    private static readonly ALWAYS_AUTO_APPROVE_NAMES: ReadonlySet<string> = new Set([
        'change_title',
        'mcp__happy__change_title',
    ]);

    // Tool-call IDs that should auto-approve when they exactly match one of
    // these values or start with `<name>-` (e.g. `change_title-1765385846663`).
    // Substring matching was a bypass vector — any tool whose ID happened to
    // contain `change_title` as a substring would be silently approved.
    private static readonly ALWAYS_AUTO_APPROVE_ID_PREFIXES: readonly string[] = [
        'change_title',
    ];

    constructor(session: ApiSessionClient) {
        super(session);
    }

    protected getLogPrefix(): string {
        return '[Codex]';
    }

    /**
     * Prompts whose wait has been published to a messenger, by permission id
     * (Saycode specs/desktop-messenger-channels — R8/R9).
     *
     * Every entry is `answerable: false`. Codex registers no dedicated `channel-permission` RPC at
     * all, so an external answer has no route here in the first place; the flag is what makes that
     * explicit rather than incidental, and it is why every Codex observation is `desktop-only`
     * rather than `generic`. Approving a Codex prompt from a messenger is not supported, and this
     * is only the guidance that says the turn is waiting and to go to Desktop.
     */
    private readonly channelBindings = new Map<string, ChannelPermissionBinding>();

    /**
     * Publishes the wait for a prompt whose turn Core could name.
     *
     * Called from inside `handleToolCall`, immediately after the pending request is registered.
     * That placement is the point: called from the approval boundary *before* `handleToolCall`,
     * there is no pending request yet and every publish is dropped — which is exactly the defect
     * this replaced. There is no ordering left for a call site to get wrong.
     *
     * The turn arrives resolved, from the approval request's own provider turn id — never from
     * "whatever turn is current". A prompt whose turn could not be resolved publishes nothing:
     * the messenger is then no better informed than before, which is the fail-closed direction,
     * and no wait is ever attributed to another request.
     */
    private observeChannelWait(input: {
        permissionId: string;
        turnId: string;
        channelRequestId: string | null;
        runtimeId: string;
    }): void {
        const binding: ChannelPermissionBinding = {
            permissionId: input.permissionId,
            turnId: input.turnId,
            channelRequestId: input.channelRequestId,
            runtimeId: input.runtimeId,
            answerable: false,
        };
        const observation = buildChannelApprovalObservation(binding);
        // An in-app prompt resolves to null here: it belongs to the Desktop user, and pointing a
        // messenger at it would hand it to someone who is not looking at it.
        if (!observation) return;
        this.channelBindings.set(input.permissionId, binding);
        this.session.sendSessionProtocolMessage(
            createEnvelope('agent', channelApprovalEvent(observation, Date.now())),
        );
    }

    /** What an external surface may know about a prompt. No arguments, no tool output. */
    channelBindingFor(permissionId: string): ChannelPermissionBinding | undefined {
        return this.channelBindings.get(permissionId);
    }

    /**
     * Retracts a published wait, on every path the prompt leaves by.
     *
     * The base calls this only after the request has been removed and resolved, and swallows
     * anything thrown here, so a failed publish cannot turn an answered permission into an
     * unanswered one.
     */
    protected override onPendingSettled(permissionId: string, reason: PendingSettlementReason): void {
        const binding = this.channelBindings.get(permissionId);
        if (!binding) return;
        this.channelBindings.delete(permissionId);
        const observation = buildChannelApprovalObservation(binding);
        if (!observation) return;
        this.session.sendSessionProtocolMessage(
            createEnvelope('agent', channelApprovalWithdrawnEvent(observation, reason, Date.now())),
        );
    }

    private shouldAutoApprove(
        toolName: string,
        toolCallId: string,
        context?: { serverName?: string },
    ): boolean {
        if (context?.serverName === 'codex_apps') {
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
        input: unknown,
        context?: {
            serverName?: string;
            /**
             * The turn this approval belongs to, already resolved from the request's own provider
             * turn id. Absent means it could not be resolved, and nothing is published.
             */
            channelTurn?: { turnId: string; channelRequestId: string | null; runtimeId: string };
        },
    ): Promise<PermissionResult> {
        if (this.shutdownClosed) return { decision: 'abort' };
        if (this.shouldAutoApprove(toolName, toolCallId, context)) {
            logger.debug(`${this.getLogPrefix()} Auto-approving tool ${toolName} (${toolCallId})`);

            const completedAt = Date.now();
            this.session.updateAgentState((currentState) => ({
                ...currentState,
                completedRequests: {
                    ...currentState.completedRequests,
                    [toolCallId]: {
                        tool: toolName,
                        arguments: input,
                        createdAt: completedAt,
                        completedAt,
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

            // After the pending request exists, and swallowing anything thrown: a channel
            // publisher that fails must not stop the Desktop user from being asked at all.
            if (context?.channelTurn) {
                try {
                    this.observeChannelWait({
                        permissionId: toolCallId,
                        turnId: context.channelTurn.turnId,
                        channelRequestId: context.channelTurn.channelRequestId,
                        runtimeId: context.channelTurn.runtimeId,
                    });
                } catch {
                    logger.debug(`${this.getLogPrefix()} channel wait could not be published for ${toolCallId}`);
                }
            }

            logger.debug(`${this.getLogPrefix()} Permission request sent for tool: ${toolName} (${toolCallId})`);
        });
    }
}
