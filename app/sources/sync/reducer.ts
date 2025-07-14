import { randomUUID } from "expo-crypto";
import { OutputData } from "./claudeTypes";

export type ToolCallTree = {
    id: string;
    name: string;
    messageId: string;
    state: 'running' | 'completed' | 'error';
    parentId: string | null;
    children: ToolCallTree[];
}

export type ReducerState = {
    serverMessageIds: Map<string, string>;
    toolCalls: Map<string, ToolCallTree>;
};

export type ReducedMessage = {
    id: string;
    role: 'agent';
    content: {
        type: 'text';
        text: string;
    } | {
        type: 'tool'
    }
};

export function createReducer(): ReducerState {
    return {
        serverMessageIds: new Map(),
        toolCalls: new Map()
    }
};

export function applyMessages(state: ReducerState, messages: { id: string, content: any }[]): ReducedMessage[] {
    let newMessages: ReducedMessage[] = [];

    function allocateId(id: string) {
        if (state.serverMessageIds.has(id)) {
            return state.serverMessageIds.get(id)!;
        }
        const newId = randomUUID();
        state.serverMessageIds.set(id, newId);
        return newId;
    }

    //
    // Load tool calls
    // 

    for (let m of messages) {
        if (m.content.content.type !== 'output') {
            continue;
        }
        const content = m.content.content.data as OutputData;
        if (content.type === 'assistant' && content.message.content && content.message.content.length > 0) {
            for (let c of content.message.content) {

                // Started tools
                if (c.type === 'tool_use') {
                    let existing = state.toolCalls.get(c.id);
                    if (!existing) {
                        if (content.parent_tool_use_id) {
                            let parentTool = state.toolCalls.get(content.parent_tool_use_id);
                            if (!parentTool) { // Should not happen
                                continue;
                            }
                            let newTool = {
                                id: c.id,
                                name: c.name,
                                messageId: m.id,
                                state: 'running' as const,
                                parentId: content.parent_tool_use_id,
                                children: []
                            }
                            parentTool.children.push(newTool);
                            state.toolCalls.set(c.id, newTool);
                        }
                    }
                }

                // User responses
                if (c.type === 'tool_result') {
                    let existing = state.toolCalls.get(c.tool_use_id);
                    if (!existing || existing.state !== 'running') { // Should not happen
                        continue;
                    }
                    if (c.is_error) {
                        existing.state = 'error';
                    } else {
                        existing.state = 'completed';
                    }
                }
            }
        }
    }


    for (let m of messages) {
        if (m.content.content.type !== 'output') {
            continue;
        }
        const content = m.content.content.data as OutputData;
        if (content.type === 'assistant') {
            if (content.message.content && content.message.content.length > 0) {
                for (let c of content.message.content) {
                    if (c.type === 'text') {
                        newMessages.push({
                            role: 'agent',
                            id: allocateId(m.id),
                            content: {
                                type: 'text',
                                text: c.text
                            }
                        })
                    }
                }
            }
            // if (content.message.content.length > 0 && content.message.content[0].type === 'text') {
            //     newMessages.push({
            //         id: m.id,
            //         content: {
            //             type: 'text',
            //             text: content.message.content[0].text
            //         }
            //     }
            // }
        }
    }
    return newMessages;
}