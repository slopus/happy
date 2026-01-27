/**
 * Permission Handler for canCallTool integration
 * 
 * Replaces the MCP permission server with direct SDK integration.
 * Handles tool permission requests, responses, and state management.
 */

import { isDeepStrictEqual } from 'node:util';
import { logger } from "@/lib";
import { SDKAssistantMessage, SDKMessage, SDKUserMessage } from "../sdk";
import { PermissionResult } from "../sdk/types";
import { Session } from "../session";
import { getToolName } from "./getToolName";
import { EnhancedMode, PermissionMode } from "../loop";
import { getToolDescriptor } from "./getToolDescriptor";
import { delay } from "@/utils/time";
import { isShellCommandAllowed } from '@/agent/permissions/shellCommandAllowlist';
import { recordToolTraceEvent } from '@/agent/tools/trace/toolTrace';

interface PermissionResponse {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowedTools?: string[];
    allowTools?: string[]; // legacy alias
    /**
     * AskUserQuestion: structured answers keyed by question text.
     * Claude Code may use this to complete the interaction without a TUI.
     */
    answers?: Record<string, string>;
    receivedAt?: number;
}


interface PendingRequest {
    resolve: (value: PermissionResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    input: unknown;
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
        this.advertiseCapabilities();
        this.seedAllowlistFromAgentState();
    }

    private isToolTraceEnabled(): boolean {
        const isTruthy = (value: string | undefined): boolean =>
            typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
        return (
            isTruthy(process.env.HAPPY_STACKS_TOOL_TRACE) ||
            isTruthy(process.env.HAPPY_LOCAL_TOOL_TRACE) ||
            isTruthy(process.env.HAPPY_TOOL_TRACE)
        );
    }

    private redactToolTraceValue(value: unknown, key?: string): unknown {
        const REDACT_KEYS = new Set(['content', 'text', 'old_string', 'new_string', 'oldText', 'newText', 'oldContent', 'newContent']);

        if (typeof value === 'string') {
            if (key && REDACT_KEYS.has(key)) return `[redacted ${value.length} chars]`;
            if (value.length <= 1_000) return value;
            return `${value.slice(0, 1_000)}…(truncated ${value.length - 1_000} chars)`;
        }

        if (typeof value !== 'object' || value === null) return value;

        if (Array.isArray(value)) {
            const sliced = value.slice(0, 50).map((v) => this.redactToolTraceValue(v));
            if (value.length <= 50) return sliced;
            return [...sliced, `…(truncated ${value.length - 50} items)`];
        }

        const entries = Object.entries(value as Record<string, unknown>);
        const out: Record<string, unknown> = {};
        const sliced = entries.slice(0, 200);
        for (const [k, v] of sliced) out[k] = this.redactToolTraceValue(v, k);
        if (entries.length > 200) out._truncatedKeys = entries.length - 200;
        return out;
    }

    private seedAllowlistFromAgentState(): void {
        try {
            const snapshot = (this.session.client as any).getAgentStateSnapshot?.() ?? null;
            const completed = snapshot?.completedRequests;
            if (!completed) return;

            const isApprovedEntry = (value: unknown): value is { status: 'approved'; allowedTools?: unknown; allowTools?: unknown } => {
                if (!value || typeof value !== 'object') return false;
                return (value as any).status === 'approved';
            };

            for (const entry of Object.values(completed as Record<string, unknown>)) {
                if (!isApprovedEntry(entry)) continue;

                const list = entry.allowedTools ?? entry.allowTools;
                if (!Array.isArray(list)) continue;
                for (const tool of list) {
                    if (typeof tool !== 'string' || tool.length === 0) continue;
                    if (tool.startsWith('Bash(') || tool === 'Bash') {
                        this.parseBashPermission(tool);
                    } else {
                        this.allowedTools.add(tool);
                    }
                }
            }
        } catch (error) {
            logger.debug('[Claude] Failed to seed allowlist from agentState', error);
        }
    }

    private advertiseCapabilities(): void {
        // Capability negotiation for app ↔ agent compatibility.
        // Older agents won't set this, so clients can safely fall back to legacy behavior.
        this.session.client.updateAgentState((currentState) => {
            const currentCaps = (currentState as any).capabilities;
            if (currentCaps && currentCaps.askUserQuestionAnswersInPermission === true) {
                return currentState;
            }
            return {
                ...currentState,
                capabilities: {
                    ...(currentCaps && typeof currentCaps === 'object' ? currentCaps : {}),
                    askUserQuestionAnswersInPermission: true,
                },
            };
        });
    }

    approveToolCall(toolCallId: string, opts?: { answers?: Record<string, string> }): void {
        this.applyPermissionResponse({ id: toolCallId, approved: true, answers: opts?.answers });
    }

    private applyPermissionResponse(message: PermissionResponse): void {
        logger.debug(`Permission response: ${JSON.stringify(message)}`);

        const id = message.id;

        if (this.isToolTraceEnabled()) {
            recordToolTraceEvent({
                direction: 'inbound',
                sessionId: this.session.client.sessionId,
                protocol: 'claude',
                provider: 'claude',
                kind: 'permission-response',
                payload: {
                    type: 'permission-response',
                    permissionId: id,
                    approved: message.approved,
                    reason: typeof message.reason === 'string' ? message.reason : undefined,
                    mode: message.mode,
                    allowedTools: this.redactToolTraceValue(message.allowedTools ?? message.allowTools, 'allowedTools'),
                    answers: this.redactToolTraceValue(message.answers, 'answers'),
                },
            });
        }

        const pending = this.pendingRequests.get(id);

        if (!pending) {
            logger.debug('Permission request not found or already resolved');
            return;
        }

        // Store the response with timestamp
        this.responses.set(id, { ...message, receivedAt: Date.now() });
        this.pendingRequests.delete(id);

        // Handle the permission response based on tool type
        this.handlePermissionResponse(message, pending);

        // Move processed request to completedRequests
        this.session.client.updateAgentState((currentState) => {
            const request = currentState.requests?.[id];
            if (!request) return currentState;
            let r = { ...currentState.requests };
            delete r[id];
            return {
                ...currentState,
                requests: r,
                completedRequests: {
                    ...currentState.completedRequests,
                    [id]: {
                        ...request,
                        completedAt: Date.now(),
                        status: message.approved ? 'approved' : 'denied',
                        reason: message.reason,
                        mode: message.mode,
                        ...(Array.isArray(message.allowedTools ?? message.allowTools)
                            ? { allowedTools: (message.allowedTools ?? message.allowTools)! }
                            : null),
                    }
                }
            };
        });
    }
    
    /**
     * Set callback to trigger when permission request is made
     */
    setOnPermissionRequest(callback: (toolCallId: string) => void) {
        this.onPermissionRequestCallback = callback;
    }

    handleModeChange(mode: PermissionMode) {
        this.permissionMode = mode;
        this.session.setLastPermissionMode(mode);
    }

    /**
     * Handler response
     */
    private handlePermissionResponse(
        response: PermissionResponse,
        pending: PendingRequest
    ): void {

        // Update allowed tools
        const allowedTools = response.allowedTools ?? response.allowTools;
        if (allowedTools && allowedTools.length > 0) {
            allowedTools.forEach(tool => {
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
            this.session.setLastPermissionMode(response.mode);
        }

        // Handle default case for all tools
        if (pending.toolName === 'AskUserQuestion' && response.approved && response.answers) {
            const baseInput =
                pending.input && typeof pending.input === 'object' && !Array.isArray(pending.input)
                    ? (pending.input as Record<string, unknown>)
                    : {};
            logger.debug(
                `[AskUserQuestion] Resolving canCallTool with ${Object.keys(response.answers).length} answer(s) via updatedInput`,
            );
            pending.resolve({
                behavior: 'allow',
                updatedInput: {
                    ...baseInput,
                    answers: response.answers,
                },
            });
            return;
        }

        const result: PermissionResult = response.approved
            ? { behavior: 'allow', updatedInput: (pending.input as Record<string, unknown>) || {} }
            : {
                behavior: 'deny',
                message:
                    response.reason ||
                    `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`,
            };

        pending.resolve(result);
    }

    /**
     * Creates the canCallTool callback for the SDK
     */
    handleToolCall = async (toolName: string, input: unknown, mode: EnhancedMode, options: { signal: AbortSignal }): Promise<PermissionResult> => {

        // Check if tool is explicitly allowed
        if (toolName === 'Bash') {
            const inputObj = input as { command?: string };
            if (inputObj?.command) {
                const patterns: Array<{ kind: 'exact'; value: string } | { kind: 'prefix'; value: string }> = [];
                for (const literal of this.allowedBashLiterals) patterns.push({ kind: 'exact', value: literal });
                for (const prefix of this.allowedBashPrefixes) patterns.push({ kind: 'prefix', value: prefix });

                if (patterns.length > 0 && isShellCommandAllowed(inputObj.command, patterns)) {
                    return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
                }
            }
        } else if (this.allowedTools.has(toolName)) {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        }

        // Calculate descriptor
        const descriptor = getToolDescriptor(toolName);

        //
        // Handle special cases
        //

        if (this.permissionMode === 'bypassPermissions') {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        }

        if (this.permissionMode === 'acceptEdits' && descriptor.edit) {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        }

        //
        // Approval flow
        //

        let toolCallId = this.resolveToolCallId(toolName, input);
        if (!toolCallId) { // What if we got permission before tool call
            await delay(1000);
            toolCallId = this.resolveToolCallId(toolName, input);
            if (!toolCallId) {
                throw new Error(`Could not resolve tool call ID for ${toolName}`);
            }
        }
        return this.handlePermissionRequest(toolCallId, toolName, input, options.signal);
    }

    /**
     * Handles individual permission requests
     */
    private async handlePermissionRequest(
        id: string,
        toolName: string,
        input: unknown,
        signal: AbortSignal
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
                input
            });

            // Trigger callback to send delayed messages immediately
            if (this.onPermissionRequestCallback) {
                this.onPermissionRequestCallback(id);
            }
            
            // Send push notification
            this.session.api.push().sendToAllDevices(
                'Permission Request',
                `Claude wants to ${getToolName(toolName)}`,
                {
                    sessionId: this.session.client.sessionId,
                    requestId: id,
                    tool: toolName,
                    type: 'permission_request'
                }
            );

            // Update agent state
            this.session.client.updateAgentState((currentState) => ({
                ...currentState,
                capabilities: {
                    ...(currentState.capabilities && typeof currentState.capabilities === 'object'
                        ? currentState.capabilities
                        : {}),
                    askUserQuestionAnswersInPermission: true,
                },
                requests: {
                    ...currentState.requests,
                    [id]: {
                        tool: toolName,
                        arguments: input,
                        createdAt: Date.now()
                    }
                }
            }));

            if (this.isToolTraceEnabled()) {
                recordToolTraceEvent({
                    direction: 'outbound',
                    sessionId: this.session.client.sessionId,
                    protocol: 'claude',
                    provider: 'claude',
                    kind: 'permission-request',
                    payload: {
                        type: 'permission-request',
                        permissionId: id,
                        toolName,
                        input: this.redactToolTraceValue(input),
                    },
                });
            }

            logger.debug(`Permission request sent for tool call ${id}: ${toolName}`);
        });
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
     * Checks if a tool call is rejected
     */
    isAborted(toolCallId: string): boolean {

        // ExitPlanMode is used to negotiate a plan; even if the user rejects it (or requests changes),
        // Claude should be allowed to continue the current turn to revise the plan.
        const toolCall = this.toolCalls.find(tc => tc.id === toolCallId);
        if (toolCall && (toolCall.name === 'exit_plan_mode' || toolCall.name === 'ExitPlanMode')) {
            return false;
        }

        // If tool not approved, it's aborted
        if (this.responses.get(toolCallId)?.approved === false) {
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

        // Cancel all pending requests
        for (const [, pending] of this.pendingRequests.entries()) {
            pending.reject(new Error('Session reset'));
        }
        this.pendingRequests.clear();

        // Move all pending requests to completedRequests with canceled status
        this.session.client.updateAgentState((currentState) => {
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
        this.session.client.rpcHandlerManager.registerHandler<PermissionResponse, { ok: true }>('permission', async (message) => {
            this.applyPermissionResponse(message);
            return { ok: true } as const;
        });
    }

    /**
     * Gets the responses map (for compatibility with existing code)
     */
    getResponses(): Map<string, PermissionResponse> {
        return this.responses;
    }
}
