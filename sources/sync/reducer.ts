import { Message, ToolCall } from "./typesMessage";
import { NormalizedMessage } from "./typesRaw";

type ReducerMessage = {
    id: string;
    createdAt: number;
    role: 'user' | 'agent';
    text: string | null;
    tool: ToolCall | null;
    children: ReducerMessage[];
}

export type ReducerState = {
    toolIdToMessageId: Map<string, string>; // toolId -> messageId for result processing
    localIds: Map<string, string>;
    messageIds: Map<string, string>; // originalId -> internalId
    messages: Map<string, ReducerMessage>;
};

export function createReducer(): ReducerState {
    return {
        toolIdToMessageId: new Map(),
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
                id: mid,
                role: 'user',
                createdAt: msg.createdAt,
                text: msg.content.text,
                tool: null,
                children: []
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

            // Process text content only if it doesn't have a parent
            for (let c of msg.content) {
                if (c.type === 'text' && !c.parent_id) {
                    let mid = allocateId();
                    state.messages.set(mid, {
                        id: mid,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: c.text,
                        tool: null,
                        children: []
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
                    // Check if we've already processed this tool
                    if (!state.toolIdToMessageId.has(c.id)) {
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
                        
                        state.messages.set(mid, {
                            id: mid,
                            role: 'agent',
                            createdAt: msg.createdAt,
                            text: null,
                            tool: toolCall,
                            children: []
                        });
                        
                        // Map tool ID to message ID for result processing
                        state.toolIdToMessageId.set(c.id, mid);
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
                    // Check if we've already processed this tool
                    if (!state.toolIdToMessageId.has(c.id)) {
                        // Find parent message
                        let parentMessageId = state.toolIdToMessageId.get(c.parent_id);
                        if (!parentMessageId) {
                            continue; // Parent not found
                        }
                        
                        let parentMessage = state.messages.get(parentMessageId);
                        if (!parentMessage) {
                            continue;
                        }
                        
                        // Create child message
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
                        
                        let childMessage: ReducerMessage = {
                            id: mid,
                            role: 'agent',
                            createdAt: msg.createdAt,
                            text: null,
                            tool: toolCall,
                            children: []
                        };
                        
                        state.messages.set(mid, childMessage);
                        parentMessage.children.push(childMessage);
                        
                        // Map tool ID to message ID for result processing
                        state.toolIdToMessageId.set(c.id, mid);
                        changed.add(parentMessageId); // Mark parent as changed
                    }
                }
            }
        }
    }

    //
    // Phase 4: Process text messages with parents
    //

    for (let msg of messages) {
        if (msg.role === 'agent') {
            for (let c of msg.content) {
                if (c.type === 'text' && c.parent_id) {
                    // Find parent message
                    let parentMessageId = state.toolIdToMessageId.get(c.parent_id);
                    if (!parentMessageId) {
                        continue; // Parent not found
                    }
                    
                    let parentMessage = state.messages.get(parentMessageId);
                    if (!parentMessage) {
                        continue;
                    }
                    
                    // Create child text message
                    let mid = allocateId();
                    let childMessage: ReducerMessage = {
                        id: mid,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: c.text,
                        tool: null,
                        children: []
                    };
                    
                    state.messages.set(mid, childMessage);
                    parentMessage.children.push(childMessage);
                    changed.add(parentMessageId); // Mark parent as changed
                }
            }
        }
    }

    //
    // Phase 5: Process tool results
    //

    for (let msg of messages) {
        if (msg.role === 'agent') {
            for (let c of msg.content) {
                if (c.type === 'tool-result') {
                    // Find the message containing this tool
                    let messageId = state.toolIdToMessageId.get(c.tool_use_id);
                    if (!messageId) {
                        continue;
                    }
                    
                    let message = state.messages.get(messageId);
                    if (!message || !message.tool) {
                        continue;
                    }
                    
                    if (message.tool.state !== 'running') {
                        continue;
                    }
                    
                    // Update tool state and result
                    message.tool.state = c.is_error ? 'error' : 'completed';
                    message.tool.result = c.content;
                    message.tool.completedAt = msg.createdAt;
                    changed.add(messageId);
                }
            }
        }
    }

    //
    // Collect changed messages (only root-level messages)
    //

    // First, identify which messages are children
    let childMessageIds = new Set<string>();
    for (let msg of state.messages.values()) {
        for (let child of msg.children) {
            childMessageIds.add(child.id);
        }
    }
    
    // Only add messages that are not children of other messages
    for (let id of changed) {
        if (childMessageIds.has(id)) {
            continue; // Skip child messages
        }
        
        let existing = state.messages.get(id);
        if (!existing) continue;
        
        let message = convertReducerMessageToMessage(existing);
        if (message) {
            newMessages.push(message);
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

function convertReducerMessageToMessage(reducerMsg: ReducerMessage): Message | null {
    if (reducerMsg.role === 'user' && reducerMsg.text !== null) {
        return {
            id: reducerMsg.id,
            localId: null,
            createdAt: reducerMsg.createdAt,
            kind: 'user-text',
            text: reducerMsg.text
        };
    } else if (reducerMsg.role === 'agent' && reducerMsg.text !== null) {
        return {
            id: reducerMsg.id,
            localId: null,
            createdAt: reducerMsg.createdAt,
            kind: 'agent-text',
            text: reducerMsg.text
        };
    } else if (reducerMsg.role === 'agent' && reducerMsg.tool !== null) {
        // Convert children recursively
        let childMessages: Message[] = [];
        for (let child of reducerMsg.children) {
            let childMessage = convertReducerMessageToMessage(child);
            if (childMessage) {
                childMessages.push(childMessage);
            }
        }
        
        return {
            id: reducerMsg.id,
            localId: null,
            createdAt: reducerMsg.createdAt,
            kind: 'tool-call',
            tool: reducerMsg.tool,
            children: childMessages
        };
    }
    
    return null;
}