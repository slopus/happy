import { randomUUID } from "expo-crypto";
import { ClaudeOutputData } from "./reducerTypes";
import { DecryptedMessage, Message, ToolCall } from "./storageTypes";
import { RawJSONLinesSchema } from "./claude-code-schema";

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
        result: t.result, // Include result field
        children: normalizeToolCalls(t.children)
    }));
}

export function reducer(state: ReducerState, decryptedMsgs: DecryptedMessage[]): Message[] {
    console.log('🔄 applyMessages called with', decryptedMsgs.length, 'messages');
    console.log('📨 Input messages:', decryptedMsgs.map(m => ({ id: m.id, type: m.content?.content?.type, contentType: m.content?.content?.data?.type })));

    let newMessages: Message[] = [];

    //
    // Load tool calls
    // 

    let changed = new Set<string>();
    // There are two layers of framing around the actual raw claude code JSON
    for (let outerFrame of decryptedMsgs) {
        if (!outerFrame.content) {
            continue;
        }
        if (outerFrame.content.role !== 'agent') {
            continue;
        }
        const innerFrame = outerFrame.content.content;
        
        // There is a second layer of framing, the object transmitted by the 
        if (innerFrame.type !== 'output') {
            console.log(`⏭️  Skipping because innner frame inside ${outerFrame.id} is not 'output' type`);
            continue;
        }
        console.log(`🔍 Processing message ${outerFrame.id}, content.content.type:`, innerFrame.type);

        const parsed = RawJSONLinesSchema.safeParse(innerFrame.data);
        if (!parsed.success) {
            console.error(`❌ Failed to parse message ${outerFrame.id}:`, parsed.error);
            continue;
        }

        const rawClaudeCodeMsg = parsed.data;
        //const content = outer.content.content.data as ClaudeOutputData;
        console.log(`📋 Message ${outerFrame.id} content type:`, rawClaudeCodeMsg.type);

        // Process assistant messages for tool_use
        if (rawClaudeCodeMsg.type === 'assistant') {
            console.log(`🤖 Processing assistant message ${outerFrame.id} with ${rawClaudeCodeMsg.message.content.length} content blocks`);

            for (let c of rawClaudeCodeMsg.message.content) {
                console.log(`📦 Content block type:`, c.type);

                // Started tools
                if (c.type === 'tool_use') {
                    console.log(`🛠️  Found tool_use:`, c.id, c.name);

                    let existing = state.toolCalls.get(c.id);
                    if (!existing) {
                        if (rawClaudeCodeMsg.parent_tool_use_id) {
                            console.log(`👶 Creating child tool ${c.id} under parent ${rawClaudeCodeMsg.parent_tool_use_id}`);

                            let parentTool = state.toolCalls.get(rawClaudeCodeMsg.parent_tool_use_id);
                            if (!parentTool) { // Should not happen
                                console.warn('❌ Parent tool not found', rawClaudeCodeMsg.parent_tool_use_id);
                                continue;
                            }
                            let newTool: ToolCallTree = {
                                id: c.id,
                                name: c.name,
                                messageId: parentTool.messageId, // Use parent's message ID
                                state: 'running' as const,
                                parentId: rawClaudeCodeMsg.parent_tool_use_id,
                                arguments: c.input,
                                result: null,
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
                                result: null,
                                children: []
                            }
                            state.toolCalls.set(c.id, newTool);
                            state.messages.set(mid, { createdAt: outerFrame.createdAt, text: '', tools: [newTool] });
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
        if (rawClaudeCodeMsg.type === 'user') {
            console.log(`👤 Processing user message ${outerFrame.id} with ${rawClaudeCodeMsg.message.content.length} content blocks`);

            for (let c of rawClaudeCodeMsg.message.content) {
                if (typeof c === 'string') {
                    continue;
                }
                console.log(`📦 User content block type:`, c.type);

                if (c.type === 'tool_result') {
                    console.log(`🔧 Found tool_result for tool:`, c.tool_use_id);

                    let existing = state.toolCalls.get(c.tool_use_id);
                    
                    if (!existing || existing.state !== 'running') { // Should not happen
                        console.warn('❌ Tool not running', c.tool_use_id, existing?.state);
                        continue;
                    }

                    existing.result = rawClaudeCodeMsg.toolUseResult;

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
    for (let outer of decryptedMsgs) {
        if (!outer.content) {
            continue;
        }
        if (outer.content.role !== 'agent') {
            continue;
        }
        if (outer.content.content.type !== 'output'
            && outer.content.content.type !== 'text'
        ) {
            continue;
        }

        const content = outer.content.content.data as ClaudeOutputData;
        if (content.type === 'assistant') {
            console.log(`🤖 Checking assistant message ${outer.id} for text content`);

            if (content.message.content && content.message.content.length > 0) {
                for (let c of content.message.content) {
                    if (c.type === 'text') {
                        console.log(`📄 Found text content in message ${outer.id}:`, c.text.substring(0, 50) + '...');

                        let existing = state.messages.get(outer.id);
                        if (!existing) {
                            existing = { createdAt: outer.createdAt, text: '', tools: [] };
                            state.messages.set(outer.id, existing);
                            console.log(`🆕 Created new message entry for ${outer.id}`);
                        }
                        existing.text += c.text;
                        changed.add(outer.id);
                        console.log(`✅ Added text to message ${outer.id}, marked as changed`);
                    }
                }
            } else {
                console.log(`❌ Assistant message ${outer.id} has no content`);
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
                    localId: null,
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
                    localId: null,
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