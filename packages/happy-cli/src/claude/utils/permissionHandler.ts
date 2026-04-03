/**
 * Permission Handler for canCallTool integration
 * 
 * Replaces the MCP permission server with direct SDK integration.
 * Handles tool permission requests, responses, and state management.
 */

import { isDeepStrictEqual } from 'node:util';
import type { CanUseTool, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { logger } from "@/lib";
import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { PLAN_FAKE_REJECT, PLAN_FAKE_RESTART } from "../prompts";
import { Session } from "../session";
import { getToolName } from "./getToolName";
import { EnhancedMode, PermissionMode } from "../loop";
import { getToolDescriptor } from "./getToolDescriptor";

interface PermissionResponse {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowTools?: string[];
    receivedAt?: number;
}


interface PendingRequest {
    resolve: (value: PermissionResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    input: Record<string, unknown>;
    suggestions?: PermissionUpdate[];
}

export class PermissionHandler {
    private toolCalls: { id: string, name: string, input: any, used: boolean }[] = [];
    private responses = new Map<string, PermissionResponse>();
    private pendingRequests = new Map<string, PendingRequest>();
    private session: Session;
    private allowedTools = new Set<string>();
    private allowedBashLiterals = new Set<string>();
    private allowedBashPrefixes = new Set<string>();
    private permissionMode: PermissionMode = 'default';
    private onPermissionRequestCallback?: (toolCallId: string) => void;

    constructor(session: Session) {
        this.session = session;
        this.setupClientHandler();
    }
    
    /**
     * Set callback to trigger when permission request is made
     */
    setOnPermissionRequest(callback: (toolCallId: string) => void) {
        this.onPermissionRequestCallback = callback;
    }

    handleModeChange(mode: PermissionMode) {
        this.permissionMode = mode;
    }

    handleSyncDecision(response: PermissionResponse): void {
        this.applyPermissionResponse(response);
    }

    /**
     * Handler response
     */
    private handlePermissionResponse(
        response: PermissionResponse,
        pending: PendingRequest
    ): void {

        // Update allowed tools
        if (response.allowTools && response.allowTools.length > 0) {
            response.allowTools.forEach(tool => {
                if (tool.startsWith('Bash(') || tool === 'Bash') {
                    this.parseBashPermission(tool);
                } else {
                    this.allowedTools.add(tool);
                }
            });
        }

        // Update permission mode
        if (response.mode) {
            this.permissionMode = response.mode;
        }

        // Notify v3 mapper of the decision
        if (response.approved) {
            const decision = (response.allowTools && response.allowTools.length > 0) ? 'always' as const : 'once' as const;
            this.session.unblockToolApproved(response.id, decision);
        } else {
            this.session.unblockToolRejected(response.id, response.reason || 'Permission rejected');
        }

        // Handle
        if (pending.toolName === 'exit_plan_mode' || pending.toolName === 'ExitPlanMode') {
            // Handle exit_plan_mode specially
            logger.debug('Plan mode result received', response);
            if (response.approved) {
                logger.debug('Plan approved - injecting PLAN_FAKE_RESTART');
                // Inject the approval message at the beginning of the queue
                if (response.mode && ['default', 'acceptEdits', 'bypassPermissions'].includes(response.mode)) {
                    this.session.queue.unshift(PLAN_FAKE_RESTART, { permissionMode: response.mode });
                } else {
                    this.session.queue.unshift(PLAN_FAKE_RESTART, { permissionMode: 'default' });
                }
                pending.resolve({ behavior: 'deny', message: PLAN_FAKE_REJECT });
            } else {
                pending.resolve({ behavior: 'deny', message: response.reason || 'Plan rejected' });
            }
        } else {
            // Handle default case for all other tools
            const result: PermissionResult = response.approved
                ? {
                    behavior: 'allow',
                    updatedInput: pending.input,
                    ...(pending.suggestions && response.allowTools && response.allowTools.length > 0
                        ? { updatedPermissions: pending.suggestions }
                        : {}),
                }
                : { behavior: 'deny', message: response.reason || `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.` };

            pending.resolve(result);
        }
    }

    /**
     * Creates the canCallTool callback for the SDK
     */
    handleToolCall = async (
        toolName: string,
        input: Record<string, unknown>,
        mode: EnhancedMode,
        options: Parameters<CanUseTool>[2],
    ): Promise<PermissionResult> => {
        const updatedInput = input ?? {};

        if (toolName === 'AskUserQuestion') {
            return { behavior: 'allow', updatedInput };
        }

        // Check if tool is explicitly allowed
        if (toolName === 'Bash') {
            const inputObj = input as { command?: string };
            if (inputObj?.command) {
                // Check literal matches
                if (this.allowedBashLiterals.has(inputObj.command)) {
                    return { behavior: 'allow', updatedInput };
                }
                // Check prefix matches
                for (const prefix of this.allowedBashPrefixes) {
                    if (inputObj.command.startsWith(prefix)) {
                        return { behavior: 'allow', updatedInput };
                    }
                }
            }
        } else if (this.allowedTools.has(toolName)) {
            return { behavior: 'allow', updatedInput };
        }

        // Calculate descriptor
        const descriptor = getToolDescriptor(toolName);

        //
        // Handle special cases
        //

        if (this.permissionMode === 'bypassPermissions') {
            return { behavior: 'allow', updatedInput };
        }

        if (this.permissionMode === 'acceptEdits' && descriptor.edit) {
            return { behavior: 'allow', updatedInput };
        }

        //
        // Approval flow
        //

        const toolCallId = options.toolUseID ?? this.resolveToolCallId(toolName, input);
        if (!toolCallId) {
            throw new Error(`Could not resolve tool call ID for ${toolName}`);
        }
        return this.handlePermissionRequest(toolCallId, toolName, input, options.signal, options.suggestions);
    }

    /**
     * Handles individual permission requests
     */
    private async handlePermissionRequest(
        id: string,
        toolName: string,
        input: Record<string, unknown>,
        signal: AbortSignal,
        suggestions?: PermissionUpdate[],
    ): Promise<PermissionResult> {
        return new Promise<PermissionResult>((resolve, reject) => {
            // Set up abort signal handling
            const abortHandler = () => {
                this.pendingRequests.delete(id);
                reject(new Error('Permission request aborted'));
            };
            signal.addEventListener('abort', abortHandler, { once: true });

            // Store the pending request
            this.pendingRequests.set(id, {
                resolve: (result: PermissionResult) => {
                    signal.removeEventListener('abort', abortHandler);
                    resolve(result);
                },
                reject: (error: Error) => {
                    signal.removeEventListener('abort', abortHandler);
                    reject(error);
                },
                toolName,
                input,
                suggestions,
            });

            // Trigger callback to send delayed messages immediately
            if (this.onPermissionRequestCallback) {
                this.onPermissionRequestCallback(id);
            }
            
            // Send push notification
            this.session.push.sendSessionNotification({
                kind: 'permission',
                metadata: this.session.getMetadata(),
                data: {
                    sessionId: this.session.hapSessionId,
                    requestId: id,
                    tool: toolName,
                    type: 'permission_request',
                    provider: 'claude',
                }
            });

            // Update agent state
            this.session.updateAgentState((currentState) => ({
                ...currentState,
                requests: {
                    ...currentState.requests,
                    [id]: {
                        tool: toolName,
                        arguments: input,
                        createdAt: Date.now()
                    }
                }
            }));

            // Notify v3 mapper that this tool is blocked for permission
            this.session.blockToolForPermission(
                id,
                toolName,
                this.extractPatterns(toolName, input),
                typeof input === 'object' && input !== null ? input as Record<string, unknown> : {},
            );
            this.session.sendPermissionRequest(
                id,
                toolName,
                this.extractPatterns(toolName, input),
                typeof input === 'object' && input !== null ? input as Record<string, unknown> : {},
            );

            logger.debug(`Permission request sent for tool call ${id}: ${toolName}`);
        });
    }

    /**
     * Extracts file/command patterns from tool input for the v3 permission block.
     */
    private extractPatterns(toolName: string, input: unknown): string[] {
        if (!input || typeof input !== 'object') return ['*'];
        const inp = input as Record<string, unknown>;
        if (toolName === 'Bash' && typeof inp.command === 'string') return [inp.command];
        if (typeof inp.file_path === 'string') return [inp.file_path];
        if (typeof inp.pattern === 'string') return [inp.pattern];
        return ['*'];
    }


    /**
     * Parses Bash permission strings into literal and prefix sets
     */
    private parseBashPermission(permission: string): void {
        // Ignore plain "Bash"
        if (permission === 'Bash') {
            return;
        }

        // Match Bash(command) or Bash(command:*)
        const bashPattern = /^Bash\((.+?)\)$/;
        const match = permission.match(bashPattern);
        
        if (!match) {
            return;
        }

        const command = match[1];
        
        // Check if it's a prefix pattern (ends with :*)
        if (command.endsWith(':*')) {
            const prefix = command.slice(0, -2); // Remove :*
            this.allowedBashPrefixes.add(prefix);
        } else {
            // Literal match
            this.allowedBashLiterals.add(command);
        }
    }

    /**
     * Resolves tool call ID based on tool name and input
     */
    private resolveToolCallId(name: string, args: any): string | null {
        // Search in reverse (most recent first)
        for (let i = this.toolCalls.length - 1; i >= 0; i--) {
            const call = this.toolCalls[i];
            if (call.name === name && isDeepStrictEqual(call.input, args)) {
                if (call.used) {
                    return null;
                }
                // Found unused match - mark as used and return
                call.used = true;
                return call.id;
            }
        }

        return null;
    }

    /**
     * Handles messages to track tool calls
     */
    onMessage(message: SDKMessage): void {
        if (message.type === 'assistant') {
            const assistantMsg = message as SDKAssistantMessage;
            if (assistantMsg.message && assistantMsg.message.content) {
                for (const block of assistantMsg.message.content) {
                    if (block.type === 'tool_use') {
                        this.toolCalls.push({
                            id: block.id!,
                            name: block.name!,
                            input: block.input,
                            used: false
                        });
                    }
                }
            }
        }
        if (message.type === 'user') {
            const userMsg = message as SDKUserMessage;
            if (userMsg.message && userMsg.message.content && Array.isArray(userMsg.message.content)) {
                for (const block of userMsg.message.content) {
                    if (block.type === 'tool_result' && block.tool_use_id) {
                        const toolCall = this.toolCalls.find(tc => tc.id === block.tool_use_id);
                        if (toolCall && !toolCall.used) {
                            toolCall.used = true;
                        }
                    }
                }
            }
        }
    }

    /**
     * Checks if a tool result should force the launcher to restart.
     *
     * Normal permission denials now continue inside the same official SDK query:
     * Claude emits an error tool_result, explains the refusal, and ends the turn.
     * We only force a restart for the plan-mode fake rejection shim.
     */
    isAborted(toolCallId: string): boolean {
        const toolCall = this.toolCalls.find(tc => tc.id === toolCallId);
        if (toolCall && (toolCall.name === 'exit_plan_mode' || toolCall.name === 'ExitPlanMode')) {
            return true;
        }

        // Tool call is not aborted
        return false;
    }

    /**
     * Resets all state for new sessions
     */
    reset(): void {
        this.toolCalls = [];
        this.responses.clear();
        this.allowedTools.clear();
        this.allowedBashLiterals.clear();
        this.allowedBashPrefixes.clear();

        // Cancel all pending requests and notify v3 mapper
        for (const [id, pending] of this.pendingRequests.entries()) {
            this.session.unblockToolRejected(id, 'Session reset');
            pending.reject(new Error('Session reset'));
        }
        this.pendingRequests.clear();

        // Move all pending requests to completedRequests with canceled status
        this.session.updateAgentState((currentState) => {
            const pendingRequests = currentState.requests || {};
            const completedRequests = { ...currentState.completedRequests };

            // Move each pending request to completed with canceled status
            for (const [id, request] of Object.entries(pendingRequests)) {
                completedRequests[id] = {
                    ...request,
                    completedAt: Date.now(),
                    status: 'canceled',
                    reason: 'Session switched to local mode'
                };
            }

            return {
                ...currentState,
                requests: {}, // Clear all pending requests
                completedRequests
            };
        });
    }

    /**
     * Sets up the client handler for permission responses
     */
    private setupClientHandler(): void {
        this.session.rpcHandlerManager.registerHandler<PermissionResponse, void>('permission', async (message) => {
            logger.debug(`Permission response: ${JSON.stringify(message)}`);
            this.applyPermissionResponse(message);
        });
    }

    private applyPermissionResponse(message: PermissionResponse): void {
        const id = message.id;
        const pending = this.pendingRequests.get(id);

        if (!pending) {
            logger.debug('Permission request not found or already resolved');
            return;
        }

        const receivedAt = message.receivedAt ?? Date.now();

        // Store the response with timestamp
        this.responses.set(id, { ...message, receivedAt });
        this.pendingRequests.delete(id);

        // Handle the permission response based on tool type
        this.handlePermissionResponse({ ...message, receivedAt }, pending);

        // Move processed request to completedRequests
        this.session.updateAgentState((currentState) => {
            const request = currentState.requests?.[id];
            if (!request) return currentState;
            const requests = { ...currentState.requests };
            delete requests[id];
            return {
                ...currentState,
                requests,
                completedRequests: {
                    ...currentState.completedRequests,
                    [id]: {
                        ...request,
                        completedAt: receivedAt,
                        status: message.approved ? 'approved' : 'denied',
                        reason: message.reason,
                        mode: message.mode,
                        allowTools: message.allowTools,
                    },
                },
            };
        });
    }

    /**
     * Gets the responses map (for compatibility with existing code)
     */
    getResponses(): Map<string, PermissionResponse> {
        return this.responses;
    }
}
