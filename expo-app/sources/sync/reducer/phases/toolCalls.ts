import type { TracedMessage } from '../reducerTracer';
import type { ToolCall } from '../../typesMessage';
import { compareToolCalls } from '../../../utils/toolComparison';
import type { ReducerState } from '../reducer';

export function runToolCallsPhase(params: Readonly<{
    state: ReducerState;
    nonSidechainMessages: TracedMessage[];
    changed: Set<string>;
    allocateId: () => string;
    enableLogging: boolean;
    isPermissionRequestToolCall: (toolId: string, input: unknown) => boolean;
}>): void {
    const {
        state,
        nonSidechainMessages,
        changed,
        allocateId,
        enableLogging,
        isPermissionRequestToolCall,
    } = params;

    //
    // Phase 2: Process non-sidechain tool calls
    //

    if (enableLogging) {
        console.log(`[REDUCER] Phase 2: Processing tool calls`);
    }
    for (let msg of nonSidechainMessages) {
        if (msg.role === 'agent') {
            for (let c of msg.content) {
                if (c.type === 'tool-call') {
                    // Direct lookup by tool ID (since permission ID = tool ID now)
                    const existingMessageId = state.toolIdToMessageId.get(c.id);

                    if (existingMessageId) {
                        if (enableLogging) {
                            console.log(`[REDUCER] Found existing message for tool ${c.id}`);
                        }
                        // Update existing message with tool execution details
                        const message = state.messages.get(existingMessageId);
                        if (message?.tool) {
                            message.realID = msg.id;
                            message.tool.description = c.description;
                            message.tool.startedAt = msg.createdAt;

                            // Merge updated tool input (ACP providers can send late-arriving titles, locations,
                            // or rawInput in subsequent tool_call updates).
                            const incomingInput = c.input;
                            if (incomingInput !== undefined) {
                                const existingInput = message.tool.input;
                                const existingObj = existingInput && typeof existingInput === 'object' && !Array.isArray(existingInput)
                                    ? (existingInput as Record<string, unknown>)
                                    : null;
                                const incomingObj = incomingInput && typeof incomingInput === 'object' && !Array.isArray(incomingInput)
                                    ? (incomingInput as Record<string, unknown>)
                                    : null;

                                const merged =
                                    existingObj && incomingObj
                                        ? (() => {
                                            // Preserve existing fields (permission args are authoritative), but allow
                                            // ACP metadata (_acp) to update over time.
                                            const base = { ...incomingObj, ...existingObj };
                                            const existingAcp = existingObj._acp && typeof existingObj._acp === 'object' && !Array.isArray(existingObj._acp)
                                                ? (existingObj._acp as Record<string, unknown>)
                                                : null;
                                            const incomingAcp = incomingObj._acp && typeof incomingObj._acp === 'object' && !Array.isArray(incomingObj._acp)
                                                ? (incomingObj._acp as Record<string, unknown>)
                                                : null;
                                            if (incomingAcp) {
                                                base._acp = { ...(existingAcp ?? {}), ...incomingAcp };
                                            }
                                            return base;
                                        })()
                                        : incomingInput;

                                const inputUnchanged = compareToolCalls(
                                    { name: c.name, arguments: existingInput },
                                    { name: c.name, arguments: merged }
                                );
                                if (!inputUnchanged) {
                                    message.tool.input = merged;
                                }
                            }

                            if (!message.tool.permission && isPermissionRequestToolCall(c.id, message.tool.input)) {
                                message.tool.permission = { id: c.id, status: 'pending' };
                                message.tool.startedAt = null;
                            }

                            // If permission was approved and shown as completed (no tool), now it's running
                            if (message.tool.permission?.status === 'approved' && message.tool.state === 'completed') {
                                message.tool.state = 'running';
                                message.tool.completedAt = null;
                                message.tool.result = undefined;
                            }
                            changed.add(existingMessageId);

                            // Track TodoWrite tool inputs when updating existing messages
                            if (message.tool.name === 'TodoWrite' && message.tool.state === 'running' && message.tool.input?.todos) {
                                // Only update if this is newer than existing todos
                                if (!state.latestTodos || message.tool.createdAt > state.latestTodos.timestamp) {
                                    state.latestTodos = {
                                        todos: message.tool.input.todos,
                                        timestamp: message.tool.createdAt
                                    };
                                }
                            }
                        }
                    } else {
                        if (enableLogging) {
                            console.log(`[REDUCER] Creating new message for tool ${c.id}`);
                        }
                        // Check if there's a stored permission for this tool
                        const permission = state.permissions.get(c.id);

                        let toolCall: ToolCall = {
                            name: c.name,
                            state: 'running' as const,
                            input: permission ? permission.arguments : c.input,  // Use permission args if available
                            createdAt: permission ? permission.createdAt : msg.createdAt,  // Use permission timestamp if available
                            startedAt: msg.createdAt,
                            completedAt: null,
                            description: c.description,
                            result: undefined,
                        };

                        // Add permission info if found
                        if (permission) {
                            if (enableLogging) {
                                console.log(`[REDUCER] Found stored permission for tool ${c.id}`);
                            }
                            toolCall.permission = {
                                id: c.id,
                                status: permission.status,
                                reason: permission.reason,
                                mode: permission.mode,
                                allowedTools: permission.allowedTools,
                                decision: permission.decision
                            };

                            // Update state based on permission status
                            if (permission.status !== 'approved') {
                                toolCall.state = 'error';
                                toolCall.completedAt = permission.completedAt || msg.createdAt;
                                if (permission.reason) {
                                    toolCall.result = { error: permission.reason };
                                }
                            }
                        }

                        // Some providers persist pending permission requests as tool-call messages (without AgentState).
                        // Treat those tool-call inputs as pending permissions so the UI can render approval controls.
                        if (!permission && isPermissionRequestToolCall(c.id, c.input)) {
                            toolCall.startedAt = null;
                            toolCall.permission = { id: c.id, status: 'pending' };
                            state.permissions.set(c.id, {
                                tool: c.name,
                                arguments: c.input,
                                createdAt: msg.createdAt,
                                status: 'pending',
                            });
                        }

                        let mid = allocateId();
                        state.messages.set(mid, {
                            id: mid,
                            realID: msg.id,
                            role: 'agent',
                            createdAt: msg.createdAt,
                            text: null,
                            tool: toolCall,
                            event: null,
                            meta: msg.meta,
                        });

                        state.toolIdToMessageId.set(c.id, mid);
                        changed.add(mid);

                        // Track TodoWrite tool inputs
                        if (toolCall.name === 'TodoWrite' && toolCall.state === 'running' && toolCall.input?.todos) {
                            // Only update if this is newer than existing todos
                            if (!state.latestTodos || toolCall.createdAt > state.latestTodos.timestamp) {
                                state.latestTodos = {
                                    todos: toolCall.input.todos,
                                    timestamp: toolCall.createdAt
                                };
                            }
                        }
                    }
                }
            }
        }
    }
}

