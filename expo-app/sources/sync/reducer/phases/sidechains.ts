import type { ToolCall } from '../../typesMessage';
import type { TracedMessage } from '../reducerTracer';
import type { ReducerMessage, ReducerState } from '../reducer';
import { coerceStreamingToolResultChunk, mergeExistingStdStreamsIntoFinalResultIfMissing, mergeStreamingChunkIntoResult } from '../helpers/streamingToolResult';
import { normalizeThinkingChunk, unwrapThinkingText, wrapThinkingText } from '../helpers/thinkingText';

export function runSidechainsPhase(params: Readonly<{
    state: ReducerState;
    sidechainMessages: TracedMessage[];
    changed: Set<string>;
    allocateId: () => string;
}>): void {
    const { state, sidechainMessages, changed, allocateId } = params;

    //
    // Phase 4: Process sidechains and store them in state
    //

    // For each sidechain message, store it in the state and mark the Task as changed
    for (const msg of sidechainMessages) {
        if (!msg.sidechainId) continue;

        // Skip if we already processed this message
        if (state.messageIds.has(msg.id)) continue;

        // Mark as processed
        state.messageIds.set(msg.id, msg.id);

        // Get or create the sidechain array for this Task
        const existingSidechain = state.sidechains.get(msg.sidechainId) || [];

        // Process and add new sidechain messages
        if (msg.role === 'agent' && msg.content[0]?.type === 'sidechain') {
            // This is the sidechain root - create a user message
            let mid = allocateId();
            let userMsg: ReducerMessage = {
                id: mid,
                realID: msg.id,
                role: 'user',
                createdAt: msg.createdAt,
                text: msg.content[0].prompt,
                tool: null,
                event: null,
                meta: msg.meta,
            };
            state.messages.set(mid, userMsg);
            existingSidechain.push(userMsg);
        } else if (msg.role === 'agent') {
            // Process agent content in sidechain
            for (let c of msg.content) {
                if (c.type === 'text') {
                    let mid = allocateId();
                    let textMsg: ReducerMessage = {
                        id: mid,
                        realID: msg.id,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: c.text,
                        isThinking: false,
                        tool: null,
                        event: null,
                        meta: msg.meta,
                    };
                    state.messages.set(mid, textMsg);
                    existingSidechain.push(textMsg);
                } else if (c.type === 'thinking') {
                    const chunk = typeof c.thinking === 'string' ? normalizeThinkingChunk(c.thinking) : '';
                    if (!chunk.trim()) {
                        continue;
                    }

                    const last = existingSidechain[existingSidechain.length - 1];
                    if (last && last.role === 'agent' && last.isThinking && typeof last.text === 'string') {
                        const merged = unwrapThinkingText(last.text) + chunk;
                        last.text = wrapThinkingText(merged);
                        changed.add(last.id);
                    } else {
                        let mid = allocateId();
                        let textMsg: ReducerMessage = {
                            id: mid,
                            realID: msg.id,
                            role: 'agent',
                            createdAt: msg.createdAt,
                            text: wrapThinkingText(chunk),
                            isThinking: true,
                            tool: null,
                            event: null,
                            meta: msg.meta,
                        };
                        state.messages.set(mid, textMsg);
                        existingSidechain.push(textMsg);
                    }
                } else if (c.type === 'tool-call') {
                    // Check if there's already a permission message for this tool
                    const existingPermissionMessageId = state.toolIdToMessageId.get(c.id);

                    let mid = allocateId();
                    let toolCall: ToolCall = {
                        name: c.name,
                        state: 'running' as const,
                        input: c.input,
                        createdAt: msg.createdAt,
                        startedAt: null,
                        completedAt: null,
                        description: c.description,
                        result: undefined
                    };

                    // If there's a permission message, copy its permission info
                    if (existingPermissionMessageId) {
                        const permissionMessage = state.messages.get(existingPermissionMessageId);
                        if (permissionMessage?.tool?.permission) {
                            toolCall.permission = { ...permissionMessage.tool.permission };
                            // Update the permission message to show it's running
                            if (permissionMessage.tool.state !== 'completed' && permissionMessage.tool.state !== 'error') {
                                permissionMessage.tool.state = 'running';
                                permissionMessage.tool.startedAt = msg.createdAt;
                                permissionMessage.tool.description = c.description;
                                changed.add(existingPermissionMessageId);
                            }
                        }
                    }

                    let toolMsg: ReducerMessage = {
                        id: mid,
                        realID: msg.id,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: null,
                        tool: toolCall,
                        event: null,
                        meta: msg.meta,
                    };
                    state.messages.set(mid, toolMsg);
                    existingSidechain.push(toolMsg);

                    // Map sidechain tool separately to avoid overwriting permission mapping
                    state.sidechainToolIdToMessageId.set(c.id, mid);
                } else if (c.type === 'tool-result') {
                    // Process tool result in sidechain - update BOTH messages

                    // Update the sidechain tool message
                    let sidechainMessageId = state.sidechainToolIdToMessageId.get(c.tool_use_id);
                    if (sidechainMessageId) {
                        let sidechainMessage = state.messages.get(sidechainMessageId);
                        if (sidechainMessage && sidechainMessage.tool && sidechainMessage.tool.state === 'running') {
                            const streamChunk = coerceStreamingToolResultChunk(c.content);
                            if (streamChunk) {
                                sidechainMessage.tool.result = mergeStreamingChunkIntoResult(sidechainMessage.tool.result, streamChunk);
                            } else {
                                sidechainMessage.tool.state = c.is_error ? 'error' : 'completed';
                                sidechainMessage.tool.result = mergeExistingStdStreamsIntoFinalResultIfMissing(sidechainMessage.tool.result, c.content);
                                sidechainMessage.tool.completedAt = msg.createdAt;
                            }

                            // Update permission data if provided by backend
                            if (c.permissions) {
                                // Merge with existing permission to preserve decision field from agentState
                                if (sidechainMessage.tool.permission) {
                                    const existingDecision = sidechainMessage.tool.permission.decision;
                                    sidechainMessage.tool.permission = {
                                        ...sidechainMessage.tool.permission,
                                        id: c.tool_use_id,
                                        status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                        date: c.permissions.date,
                                        mode: c.permissions.mode,
                                        allowedTools: c.permissions.allowedTools,
                                        decision: c.permissions.decision || existingDecision
                                    };
                                } else {
                                    sidechainMessage.tool.permission = {
                                        id: c.tool_use_id,
                                        status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                        date: c.permissions.date,
                                        mode: c.permissions.mode,
                                        allowedTools: c.permissions.allowedTools,
                                        decision: c.permissions.decision
                                    };
                                }
                            }

                            changed.add(sidechainMessageId);
                        }
                    }

                    // Also update the main permission message if it exists
                    let permissionMessageId = state.toolIdToMessageId.get(c.tool_use_id);
                    if (permissionMessageId) {
                        let permissionMessage = state.messages.get(permissionMessageId);
                        if (permissionMessage && permissionMessage.tool && permissionMessage.tool.state === 'running') {
                            const streamChunk = coerceStreamingToolResultChunk(c.content);
                            if (streamChunk) {
                                permissionMessage.tool.result = mergeStreamingChunkIntoResult(permissionMessage.tool.result, streamChunk);
                            } else {
                                permissionMessage.tool.state = c.is_error ? 'error' : 'completed';
                                permissionMessage.tool.result = mergeExistingStdStreamsIntoFinalResultIfMissing(permissionMessage.tool.result, c.content);
                                permissionMessage.tool.completedAt = msg.createdAt;
                            }

                            // Update permission data if provided by backend
                            if (c.permissions) {
                                // Merge with existing permission to preserve decision field from agentState
                                if (permissionMessage.tool.permission) {
                                    const existingDecision = permissionMessage.tool.permission.decision;
                                    permissionMessage.tool.permission = {
                                        ...permissionMessage.tool.permission,
                                        id: c.tool_use_id,
                                        status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                        date: c.permissions.date,
                                        mode: c.permissions.mode,
                                        allowedTools: c.permissions.allowedTools,
                                        decision: c.permissions.decision || existingDecision
                                    };
                                } else {
                                    permissionMessage.tool.permission = {
                                        id: c.tool_use_id,
                                        status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                        date: c.permissions.date,
                                        mode: c.permissions.mode,
                                        allowedTools: c.permissions.allowedTools,
                                        decision: c.permissions.decision
                                    };
                                }
                            }

                            changed.add(permissionMessageId);
                        }
                    }
                }
            }
        }

        // Update the sidechain in state
        state.sidechains.set(msg.sidechainId, existingSidechain);

        // Find the Task tool message that owns this sidechain and mark it as changed
        // msg.sidechainId is the realID of the Task message
        for (const [internalId, message] of state.messages) {
            if (message.realID === msg.sidechainId && message.tool) {
                changed.add(internalId);
                break;
            }
        }
    }
}

