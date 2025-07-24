import { Message, ToolCall } from "./typesMessage";
import { NormalizedMessage } from "./typesRaw";

export type ToolCallTree = {
    id: string;
    name: string;
    messageId: string;
    state: 'running' | 'completed' | 'error';
    arguments: any;
    result?: unknown; // Add result field to store tool result data
    parentId: string | null;
    children: ToolCallTree[];
}

export type ReducerState = {
    toolCalls: Map<string, ToolCallTree>;
    localIds: Map<string, string>;
    messageIds: Map<string, string>; // originalId -> internalId
    messages: Map<string, { role: 'user' | 'agent', createdAt: number, text: string, tools: ToolCallTree[] }>;
};

export function createReducer(): ReducerState {
    return {
        toolCalls: new Map(),
        messages: new Map(),
        localIds: new Map(),
        messageIds: new Map()
    }
};

export function reducer(state: ReducerState, messages: NormalizedMessage[]): Message[] {
    let newMessages: Message[] = [];
    let changed: Set<string> = new Set();

    //
    // Phase 1: Process user messages and text messages
    // 

    for (let msg of messages) {
        if (msg.role === 'user') {
            // Check if we've seen this localId before
            if (msg.localId && state.localIds.has(msg.localId)) {
                continue;
            }
            // Check if we've seen this message ID before
            if (state.messageIds.has(msg.id)) {
                continue;
            }

            // Create a new message
            let mid = allocateId();
            state.messages.set(mid, {
                role: 'user',
                createdAt: msg.createdAt,
                text: msg.content.text,
                tools: []
            });
            
            // Track both localId and messageId
            if (msg.localId) {
                state.localIds.set(msg.localId, mid);
            }
            state.messageIds.set(msg.id, mid);
            
            changed.add(mid);
        } else if (msg.role === 'agent') {
            // Check if we've seen this agent message before
            if (state.messageIds.has(msg.id)) {
                continue;
            }
            
            // Mark this message as seen
            state.messageIds.set(msg.id, msg.id);
            
            // Process text content only in this phase
            for (let c of msg.content) {
                if (c.type === 'text') {
                    let mid = allocateId();
                    state.messages.set(mid, {
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: c.text,
                        tools: []
                    });
                    changed.add(mid);
                }
            }
        }
    }

    //
    // Phase 2: Process tool calls without parents (root tools)
    //

    for (let msg of messages) {
        if (msg.role === 'agent') {
            for (let c of msg.content) {
                if (c.type === 'tool-call' && !c.parent_id) {
                    let existing = state.toolCalls.get(c.id);
                    if (!existing) {
                        let mid = allocateId();
                        let newTool = {
                            id: c.id,
                            name: c.name,
                            messageId: mid, // This is the root message ID
                            state: 'running' as const,
                            parentId: null,
                            arguments: c.input,
                            result: null,
                            children: []
                        }
                        state.toolCalls.set(c.id, newTool);
                        state.messages.set(mid, { role: 'agent', createdAt: msg.createdAt, text: '', tools: [newTool] });
                        changed.add(mid);
                    }
                }
            }
        }
    }

    //
    // Phase 3: Process tool calls with parents (child tools)
    //

    for (let msg of messages) {
        if (msg.role === 'agent') {
            for (let c of msg.content) {
                if (c.type === 'tool-call' && c.parent_id) {
                    let existing = state.toolCalls.get(c.id);
                    if (!existing) {
                        let parentTool = state.toolCalls.get(c.parent_id);
                        if (!parentTool) { // Should not happen
                            continue;
                        }
                        let newTool: ToolCallTree = {
                            id: c.id,
                            name: c.name,
                            messageId: parentTool.messageId, // Use parent's message ID
                            state: 'running' as const,
                            parentId: c.parent_id,
                            arguments: c.input,
                            result: null,
                            children: []
                        }
                        parentTool.children.push(newTool);
                        state.toolCalls.set(c.id, newTool);
                        changed.add(parentTool.messageId);
                    }
                }
            }
        }
    }

    //
    // Phase 4: Process tool results
    //

    for (let msg of messages) {
        if (msg.role === 'agent') {
            for (let c of msg.content) {
                if (c.type === 'tool-result') {
                    let existing = state.toolCalls.get(c.tool_use_id);
                    if (!existing) {
                        continue;
                    }
                    if (existing.state !== 'running') {
                        continue;
                    }
                    existing.state = c.is_error ? 'error' : 'completed';
                    existing.result = c.content;
                    changed.add(existing.messageId);
                }
            }
        }
    }

    //
    // Collect changed messages
    //

    for (let id of changed) {
        let existing = state.messages.get(id);
        if (existing && existing.role === 'agent') {
            if (existing.tools.length > 0) {
                newMessages.push({
                    id,
                    localId: null,
                    createdAt: existing.createdAt,
                    kind: 'tool-call',
                    tools: normalizeToolCalls(existing.tools)
                });
            } else {
                newMessages.push({
                    id,
                    localId: null,
                    createdAt: existing.createdAt,
                    kind: 'agent-text',
                    text: existing.text
                });
            }
        }
        if (existing && existing.role === 'user') {
            newMessages.push({
                id,
                localId: null,
                createdAt: existing.createdAt,
                kind: 'user-text',
                text: existing.text
            });
        }
    }

    return newMessages;
}

//
// Helpers
//


function allocateId() {
    return Math.random().toString(36).substring(2, 15);
}

function normalizeToolCalls(toolCalls: ToolCallTree[]): ToolCall[] {
    return toolCalls.map(t => ({
        name: t.name,
        input: t.arguments,
        state: t.state,
        result: t.result, // Include result field
        children: normalizeToolCalls(t.children)
    }));
}