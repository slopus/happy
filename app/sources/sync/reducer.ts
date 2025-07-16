import { randomUUID } from "expo-crypto";
import { ClaudeOutputData } from "./reducerTypes";
import { DecryptedMessage, Message, ToolCall } from "./storageTypes";

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
    messages: Map<string, { createdAt: number, text: string, tools: ToolCallTree[] }>; // TODO: Copy and normalize
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

export function reducer(state: ReducerState, messages: DecryptedMessage[]): Message[] {
    console.log('🔄 applyMessages called with', messages.length, 'messages');
    console.log('📨 Input messages:', messages.map(m => ({ id: m.id, type: m.content?.content?.type, contentType: m.content?.content?.data?.type })));

    let newMessages: Message[] = [];

    //
    // Load tool calls
    // 

    let changed = new Set<string>();
    for (let m of messages) {
        if (!m.content) {
            continue;
        }
        if (m.content.role !== 'agent') {
            continue;
        }
        console.log(`🔍 Processing message ${m.id}, content.content.type:`, m.content.content.type);

        if (m.content.content.type !== 'output') {
            console.log(`⏭️  Skipping message ${m.id} - not output type`);
            continue;
        }
        const content = m.content.content.data as ClaudeOutputData;
        console.log(`📋 Message ${m.id} content type:`, content.type);

        // Process assistant messages for tool_use
        if (content.type === 'assistant' && content.message.content && content.message.content.length > 0) {
            console.log(`🤖 Processing assistant message ${m.id} with ${content.message.content.length} content blocks`);

            for (let c of content.message.content) {
                console.log(`📦 Content block type:`, c.type);

                // Started tools
                if (c.type === 'tool_use') {
                    console.log(`🛠️  Found tool_use:`, c.id, c.name);

                    let existing = state.toolCalls.get(c.id);
                    if (!existing) {
                        if (content.parent_tool_use_id) {
                            console.log(`👶 Creating child tool ${c.id} under parent ${content.parent_tool_use_id}`);

                            let parentTool = state.toolCalls.get(content.parent_tool_use_id);
                            if (!parentTool) { // Should not happen
                                console.warn('❌ Parent tool not found', content.parent_tool_use_id);
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
                            console.log(`✅ Created child tool ${c.id}, marked message ${parentTool.messageId} as changed`);
                        } else {
                            console.log(`🌱 Creating root tool ${c.id}`);

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
                            state.messages.set(mid, { createdAt: m.createdAt, text: '', tools: [newTool] });
                            changed.add(mid);
                            console.log(`✅ Created root tool ${c.id} with message ID ${mid}, marked as changed`);
                        }
                    } else {
                        console.log(`⚠️  Tool ${c.id} already exists, skipping`);
                    }
                }
            }
        }

        // Process user messages for tool_result
        if (content.type === 'user' && content.message.content && content.message.content.length > 0) {
            console.log(`👤 Processing user message ${m.id} with ${content.message.content.length} content blocks`);

            for (let c of content.message.content) {
                console.log(`📦 User content block type:`, c.type);

                if (c.type === 'tool_result') {
                    console.log(`🔧 Found tool_result for tool:`, c.tool_use_id);

                    let existing = state.toolCalls.get(c.tool_use_id);
                    if (!existing || existing.state !== 'running') { // Should not happen
                        console.warn('❌ Tool not running', c.tool_use_id, existing?.state);
                        continue;
                    }
                    if (c.is_error) {
                        existing.state = 'error';
                        console.log(`💥 Tool ${c.tool_use_id} marked as error`);
                    } else {
                        existing.state = 'completed';
                        console.log(`✅ Tool ${c.tool_use_id} marked as completed`);
                    }

                    // Mark the message containing this tool as changed
                    changed.add(existing.messageId);
                    console.log(`📝 Marked message ${existing.messageId} as changed due to tool result`);
                }
            }
        }
    }

    console.log('🛠️  Final tool calls state:', JSON.stringify(Array.from(state.toolCalls.values()), null, 2));

    //
    // Load text messages
    //

    console.log('📝 Processing text messages...');
    for (let m of messages) {
        if (!m.content) {
            continue;
        }
        if (m.content.role !== 'agent') {
            continue;
        }
        if (m.content.content.type !== 'text') {
            continue;
        }
        const content = m.content.content.data as ClaudeOutputData;
        if (content.type === 'assistant') {
            console.log(`🤖 Checking assistant message ${m.id} for text content`);

            if (content.message.content && content.message.content.length > 0) {
                for (let c of content.message.content) {
                    if (c.type === 'text') {
                        console.log(`📄 Found text content in message ${m.id}:`, c.text.substring(0, 50) + '...');

                        let existing = state.messages.get(m.id);
                        if (!existing) {
                            existing = { createdAt: m.createdAt, text: '', tools: [] };
                            state.messages.set(m.id, existing);
                            console.log(`🆕 Created new message entry for ${m.id}`);
                        }
                        existing.text += c.text;
                        changed.add(m.id);
                        console.log(`✅ Added text to message ${m.id}, marked as changed`);
                    }
                }
            } else {
                console.log(`❌ Assistant message ${m.id} has no content`);
            }
        }
    }

    //
    // Collect changed messages
    //

    console.log('🔄 Changed messages:', Array.from(changed));
    for (let id of changed) {
        let existing = state.messages.get(id);
        if (existing) {
            if (existing.tools.length > 0) {
                console.log(`🛠️  Adding tool message ${id} with ${existing.tools.length} tools`);
                JSON.stringify(existing.tools, null, 2)
                newMessages.push({
                    role: 'agent',
                    id,
                    createdAt: existing.createdAt,
                    content: {
                        type: 'tool',
                        tools: normalizeToolCalls(existing.tools)
                    }
                });
            } else {
                console.log(`📄 Adding text message ${id} with text:`, existing.text.substring(0, 50) + '...');
                newMessages.push({
                    role: 'agent',
                    id,
                    createdAt: existing.createdAt,
                    content: {
                        type: 'text',
                        text: existing.text
                    }
                });
            }
        } else {
            console.warn(`⚠️  Changed message ${id} not found in state.messages`);
        }
    }

    console.log('🎯 Returning', newMessages.length, 'processed messages');
    console.log('📤 Output messages:', newMessages.map(m => ({ id: m.id, type: m.content.type, hasContent: m.content.type === 'text' ? !!m.content.text : m.content.tools.length })));

    return newMessages;
}