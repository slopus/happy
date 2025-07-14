import { randomUUID } from "expo-crypto";
import { OutputData } from "./claudeTypes";

export type ToolCallTree = {
    id: string;
    name: string;
    messageId: string;
    state: 'running' | 'completed' | 'error';
    arguments: any;
    parentId: string | null;
    children: ToolCallTree[];
}

export type ReducerState = {
    toolCalls: Map<string, ToolCallTree>;
    messages: Map<string, { text: string, tools: ToolCallTree[] }>; // TODO: Copy and normalize
};

export type ToolCall = {
    name: string;
    state: 'running' | 'completed' | 'error';
    arguments: any;
    children: ToolCall[];
}

export type ReducedMessage = {
    id: string;
    role: 'agent';
    content: {
        type: 'text';
        text: string;
    } | {
        type: 'tool';
        tools: ToolCall[];
    }
};

export function createReducer(): ReducerState {
    return {
        toolCalls: new Map(),
        messages: new Map()
    }
};

function allocateId() {
    return randomUUID();
}

function normalizeToolCalls(toolCalls: ToolCallTree[]): ToolCall[] {
    console.warn(toolCalls);
    return toolCalls.map(t => ({
        name: t.name,
        state: t.state,
        arguments: t.arguments,
        children: normalizeToolCalls(t.children)
    }));
}

export function applyMessages(state: ReducerState, messages: { id: string, content: any }[]): ReducedMessage[] {
    let newMessages: ReducedMessage[] = [];

    //
    // Load tool calls
    // 

    let changed = new Set<string>();
    for (let m of messages) {
        if (m.content.content.type !== 'output') {
            continue;
        }
        const content = m.content.content.data as OutputData;

        // Process assistant messages for tool_use
        if (content.type === 'assistant' && content.message.content && content.message.content.length > 0) {
            for (let c of content.message.content) {

                // Started tools
                if (c.type === 'tool_use') {
                    let existing = state.toolCalls.get(c.id);
                    if (!existing) {
                        if (content.parent_tool_use_id) {
                            let parentTool = state.toolCalls.get(content.parent_tool_use_id);
                            if (!parentTool) { // Should not happen
                                console.warn('Parent tool not found', content.parent_tool_use_id);
                                continue;
                            }
                            let newTool = {
                                id: c.id,
                                name: c.name,
                                messageId: parentTool.messageId, // Use parent's message ID
                                state: 'running' as const,
                                parentId: content.parent_tool_use_id,
                                arguments: c.input,
                                children: []
                            }
                            parentTool.children.push(newTool);
                            state.toolCalls.set(c.id, newTool);
                            changed.add(parentTool.messageId); // Mark parent's message as changed
                        } else {
                            let mid = allocateId();
                            let newTool = {
                                id: c.id,
                                name: c.name,
                                messageId: mid, // This is the root message ID
                                state: 'running' as const,
                                parentId: null,
                                arguments: c.input,
                                children: []
                            }
                            state.toolCalls.set(c.id, newTool);
                            state.messages.set(mid, { text: '', tools: [newTool] });
                            changed.add(mid);
                        }
                    }
                }
            }
        }

        // Process user messages for tool_result
        if (content.type === 'user' && content.message.content && content.message.content.length > 0) {
            for (let c of content.message.content) {
                if (c.type === 'tool_result') {
                    let existing = state.toolCalls.get(c.tool_use_id);
                    if (!existing || existing.state !== 'running') { // Should not happen
                        console.warn('Tool not running', c.tool_use_id);
                        continue;
                    }
                    if (c.is_error) {
                        existing.state = 'error';
                    } else {
                        existing.state = 'completed';
                    }

                    // Mark the message containing this tool as changed
                    changed.add(existing.messageId);
                }
            }
        }
    }

    // console.log(JSON.stringify(Array.from(state.toolCalls.values()), null, 2));

    //
    // Load text messages
    //

    for (let m of messages) {
        if (m.content.content.type !== 'output') {
            continue;
        }
        const content = m.content.content.data as OutputData;
        if (content.type === 'assistant') {
            if (content.message.content && content.message.content.length > 0) {
                for (let c of content.message.content) {
                    if (c.type === 'text') {
                        let existing = state.messages.get(m.id);
                        if (!existing) {
                            existing = { text: '', tools: [] };
                            state.messages.set(m.id, existing);
                        }
                        existing.text += c.text;
                        changed.add(m.id);
                    }
                }
            }
        }
    }

    //
    // Collect changed messages
    //

    for (let id of changed) {
        let existing = state.messages.get(id);
        if (existing) {
            if (existing.tools.length > 0) {
                JSON.stringify(existing.tools, null, 2)
                newMessages.push({
                    role: 'agent',
                    id,
                    content: {
                        type: 'tool',
                        tools: normalizeToolCalls(existing.tools)
                    }
                });
            } else {
                newMessages.push({
                    role: 'agent',
                    id,
                    content: {
                        type: 'text',
                        text: existing.text
                    }
                });
            }
        }
    }
    return newMessages;
}