/**
 * Message Reducer for Real-time Sync System
 * 
 * This reducer is the core message processing engine that transforms raw messages from
 * the sync system into a structured, deduplicated message history. It handles complex
 * scenarios including tool permissions, sidechains, and message deduplication.
 * 
 * ## Core Responsibilities:
 * 
 * 1. **Message Deduplication**: Prevents duplicate messages using multiple tracking mechanisms:
 *    - localId tracking for user messages
 *    - messageId tracking for all messages
 *    - Permission ID tracking for tool permissions
 * 
 * 2. **Tool Permission Management**: Integrates with AgentState to handle tool permissions:
 *    - Creates placeholder messages for pending permission requests
 *    - Updates permission status (pending → approved/denied/canceled)
 *    - Matches incoming tool calls to approved permissions
 *    - Prioritizes tool calls over permissions when both exist
 * 
 * 3. **Tool Call Lifecycle**: Manages the complete lifecycle of tool calls:
 *    - Creation from permission requests or direct tool calls
 *    - Matching tool calls to existing permission messages
 *    - Processing tool results and updating states
 *    - Handling errors and completion states
 * 
 * 4. **Sidechain Processing**: Handles nested conversation branches (sidechains):
 *    - Identifies sidechain messages using the tracer
 *    - Stores sidechain messages separately
 *    - Links sidechains to their parent tool calls
 * 
 * ## Processing Phases:
 * 
 * The reducer processes messages in a specific order to ensure correct behavior:
 * 
 * **Phase 0: AgentState Permissions**
 *   - Processes pending and completed permission requests
 *   - Creates tool messages for permissions
 *   - Skips completed permissions if matching tool call (same name AND arguments) exists in incoming messages
 *   - Phase 2 will handle matching tool calls to existing permission messages
 * 
 * **Phase 1: User and Text Messages**
 *   - Processes user messages with deduplication
 *   - Processes agent text messages
 *   - Skips tool calls for later phases
 * 
 * **Phase 2: Tool Calls**
 *   - Processes incoming tool calls from agents
 *   - Matches to existing permission messages when possible
 *   - Creates new tool messages when no match exists
 *   - Prioritizes newest permission when multiple matches
 * 
 * **Phase 3: Tool Results**
 *   - Updates tool messages with results
 *   - Sets completion or error states
 *   - Updates completion timestamps
 * 
 * **Phase 4: Sidechains**
 *   - Processes sidechain messages separately
 *   - Stores in sidechain map linked to parent tool
 *   - Handles nested tool calls within sidechains
 * 
 * **Phase 5: Mode Switch Events**
 *   - Processes agent event messages
 *   - Handles mode changes and other events
 * 
 * ## Key Behaviors:
 * 
 * - **Idempotency**: Calling the reducer multiple times with the same data produces no duplicates
 * - **Priority Rules**: When both tool calls and permissions exist, tool calls take priority
 * - **Argument Matching**: Tool calls match to permissions based on both name AND arguments
 * - **Timestamp Preservation**: Original timestamps are preserved when matching tools to permissions
 * - **State Persistence**: The ReducerState maintains all mappings across calls
 * - **Message Immutability**: NEVER modify message timestamps or core properties after creation
 *   Messages can only have their tool state/result updated, never their creation metadata
 * - **Timestamp Preservation**: NEVER change a message's createdAt timestamp. The timestamp
 *   represents when the message was originally created and must be preserved throughout all
 *   processing phases. This is critical for maintaining correct message ordering.
 * 
 * ## Permission Matching Algorithm:
 * 
 * When a tool call arrives, the matching algorithm:
 * 1. Checks if the tool has already been processed (via toolIdToMessageId)
 * 2. Searches for approved permission messages with:
 *    - Same tool name
 *    - Matching arguments (deep equality)
 *    - Not already linked to another tool
 * 3. Prioritizes the newest matching permission
 * 4. Updates the permission message with tool execution details
 * 5. Falls back to creating a new tool message if no match
 * 
 * ## Data Flow:
 * 
 * Raw Messages → Normalizer → Reducer → Structured Messages
 *                              ↑
 *                         AgentState
 * 
 * The reducer receives:
 * - Normalized messages from the sync system
 * - Current AgentState with permission information
 * 
 * And produces:
 * - Structured Message objects for UI rendering
 * - Updated internal state for future processing
 */

import { Message, ToolCall } from "../typesMessage";
import { AgentEvent, NormalizedMessage } from "../typesRaw";
import { createTracer, traceMessages, TracerState } from "./reducerTracer";
import { AgentState } from "../storageTypes";

type ReducerMessage = {
    id: string;
    realID: string | null;
    createdAt: number;
    role: 'user' | 'agent';
    text: string | null;
    event: AgentEvent | null;
    tool: ToolCall | null;
}

export type ReducerState = {
    toolIdToMessageId: Map<string, string>; // toolId -> messageId for result processing
    permissionIdToMessageId: Map<string, string>; // permissionId -> messageId for permission tracking
    permissionIdToToolId: Map<string, string>; // permissionId -> toolId for linking permissions to tools
    localIds: Map<string, string>;
    messageIds: Map<string, string>; // originalId -> internalId
    messages: Map<string, ReducerMessage>;
    sidechains: Map<string, ReducerMessage[]>;
    tracerState: TracerState; // Tracer state for sidechain processing
};

export function createReducer(): ReducerState {
    return {
        toolIdToMessageId: new Map(),
        permissionIdToMessageId: new Map(),
        permissionIdToToolId: new Map(),
        messages: new Map(),
        localIds: new Map(),
        messageIds: new Map(),
        sidechains: new Map(),
        tracerState: createTracer()
    }
};

export function reducer(state: ReducerState, messages: NormalizedMessage[], agentState?: AgentState | null): Message[] {
    console.log(`[REDUCER] Called with ${messages.length} messages, agentState: ${agentState ? 'YES' : 'NO'}`);
    if (agentState?.requests) {
        console.log(`[REDUCER] AgentState has ${Object.keys(agentState.requests).length} pending requests`);
    }
    if (agentState?.completedRequests) {
        console.log(`[REDUCER] AgentState has ${Object.keys(agentState.completedRequests).length} completed requests`);
    }
    
    let newMessages: Message[] = [];
    let changed: Set<string> = new Set();

    // First, trace all messages to identify sidechains
    const tracedMessages = traceMessages(state.tracerState, messages);

    // Separate sidechain and non-sidechain messages
    const nonSidechainMessages = tracedMessages.filter(msg => !msg.sidechainId);
    const sidechainMessages = tracedMessages.filter(msg => msg.sidechainId);

    // Build a list of incoming tool calls for deduplication
    const incomingTools: Array<{ name: string, args: any }> = [];
    for (let msg of nonSidechainMessages) {
        if (msg.role === 'agent') {
            for (let c of msg.content) {
                if (c.type === 'tool-call') {
                    incomingTools.push({ name: c.name, args: c.input });
                }
            }
        }
    }

    //
    // Phase 0: Process AgentState permissions
    //

    console.log(`[REDUCER] Phase 0: Processing AgentState`);
    if (agentState) {
        // Process pending permission requests
        if (agentState.requests) {
            for (const [permId, request] of Object.entries(agentState.requests)) {
                // Skip if this permission is also in completedRequests (completed takes precedence)
                if (agentState.completedRequests && agentState.completedRequests[permId]) {
                    continue;
                }
                
                // Check if we already have a message for this permission
                if (!state.permissionIdToMessageId.has(permId)) {
                    // Check if there's an existing tool message that matches this permission
                    let existingToolMessageId: string | undefined;
                    let matchingToolId: string | undefined;
                    
                    console.log(`[REDUCER] Looking for existing tool to match permission ${permId} (${request.tool})`);
                    console.log(`[REDUCER] state.toolIdToMessageId has ${state.toolIdToMessageId.size} tools`);
                    console.log(`[REDUCER] state.messages has ${state.messages.size} messages`);
                    
                    // Look through existing tool messages to find a match
                    for (const [toolId, msgId] of state.toolIdToMessageId) {
                        const message = state.messages.get(msgId);
                        console.log(`[REDUCER] Checking tool ${toolId} -> msgId ${msgId}, message exists: ${!!message}`);
                        if (message?.tool && 
                            message.tool.name === request.tool &&
                            deepEqual(message.tool.input, request.arguments) &&
                            message.tool.permission === undefined) { // Only match if no permission field at all
                            console.log(`[REDUCER] MATCH FOUND! Tool ${toolId} matches permission ${permId}`);
                            existingToolMessageId = msgId;
                            matchingToolId = toolId;
                            break;
                        }
                    }
                    
                    if (existingToolMessageId && matchingToolId) {
                        console.log(`[REDUCER] Updating existing tool message ${existingToolMessageId} with permission ${permId}`);
                        // Update the existing tool message with permission
                        const message = state.messages.get(existingToolMessageId);
                        if (message?.tool) {
                            // Only set permission if it doesn't already have one
                            // This prevents overwriting an approved permission with pending
                            if (!message.tool.permission) {
                                message.tool.permission = {
                                    id: permId,
                                    status: 'pending'
                                };
                                changed.add(existingToolMessageId);
                                console.log(`[REDUCER] Added permission to tool, added to changed set`);
                            }
                            state.permissionIdToMessageId.set(permId, existingToolMessageId);
                            state.permissionIdToToolId.set(permId, matchingToolId);
                        }
                    } else {
                        console.log(`[REDUCER] No existing tool found for permission ${permId}, creating new message`);
                        
                        // Create a new tool message for the permission request
                        let mid = allocateId();
                        let toolCall: ToolCall = {
                            name: request.tool,
                            state: 'running' as const,
                            input: request.arguments,
                            createdAt: request.createdAt || Date.now(),
                            startedAt: null,
                            completedAt: null,
                            description: null,
                            result: undefined,
                            permission: {
                                id: permId,
                                status: 'pending'
                            }
                        };

                        state.messages.set(mid, {
                            id: mid,
                            realID: null,
                            role: 'agent',
                            createdAt: request.createdAt || Date.now(),
                            text: null,
                            tool: toolCall,
                            event: null,
                        });

                        state.permissionIdToMessageId.set(permId, mid);
                        changed.add(mid);
                    }
                }
            }
        }

        // Process completed permission requests
        if (agentState.completedRequests) {
            for (const [permId, completed] of Object.entries(agentState.completedRequests)) {
                // Find the message for this permission
                const messageId = state.permissionIdToMessageId.get(permId);
                if (messageId) {
                    const message = state.messages.get(messageId);
                    if (message?.tool) {
                        // Skip if tool has already started actual execution (not just linked)
                        // Check if it has startedAt AND the permission was already approved
                        const toolId = state.permissionIdToToolId.get(permId);
                        if (toolId && message.tool.startedAt && message.tool.permission?.status === 'approved') {
                            // Tool already executing with approval, don't change permission
                            continue;
                        }
                        
                        // Skip if this is already a completed request with the same status
                        if (message.tool.permission?.status === completed.status && 
                            message.tool.permission?.reason === completed.reason) {
                            continue;
                        }
                        
                        let hasChanged = false;
                        
                        // Update permission status if needed
                        if (!message.tool.permission) {
                            message.tool.permission = {
                                id: permId,
                                status: completed.status
                            };
                            hasChanged = true;
                        } else if (message.tool.permission.status !== completed.status) {
                            message.tool.permission.status = completed.status;
                            hasChanged = true;
                        }
                        
                        if (completed.reason && message.tool.permission?.reason !== completed.reason) {
                            message.tool.permission!.reason = completed.reason;
                            hasChanged = true;
                        }

                        // Update tool state based on permission status
                        if (completed.status === 'approved') {
                            // Keep as running, waiting for actual tool execution
                            // Don't change state if tool already completed or errored
                            if (message.tool.state !== 'completed' && message.tool.state !== 'error' && message.tool.state !== 'running') {
                                message.tool.state = 'running';
                                hasChanged = true;
                            }
                        } else {
                            // denied or canceled
                            // Don't change to error if tool already completed successfully
                            if (message.tool.state !== 'error' && message.tool.state !== 'completed') {
                                message.tool.state = 'error';
                                message.tool.completedAt = completed.completedAt || Date.now();
                                if (!message.tool.result && completed.reason) {
                                    message.tool.result = { error: completed.reason };
                                }
                                hasChanged = true;
                            }
                        }

                        if (hasChanged) {
                            changed.add(messageId);
                        }
                    }
                } else {
                    // Completed request - either without a pending request, or we skipped the pending one
                    // First check if there's an existing tool message that matches
                    let existingToolMessageId: string | undefined;
                    let matchingToolId: string | undefined;
                    
                    // Look through existing tool messages to find a match
                    for (const [toolId, msgId] of state.toolIdToMessageId) {
                        const message = state.messages.get(msgId);
                        if (message?.tool && 
                            message.tool.name === completed.tool &&
                            deepEqual(message.tool.input, completed.arguments) &&
                            message.tool.permission === undefined) { // Only match if no permission field at all
                            existingToolMessageId = msgId;
                            matchingToolId = toolId;
                            break;
                        }
                    }
                    
                    if (existingToolMessageId && matchingToolId) {
                        // Update the existing tool message with permission
                        const message = state.messages.get(existingToolMessageId);
                        if (message?.tool) {
                            message.tool.permission = {
                                id: permId,
                                status: completed.status,
                                reason: completed.reason || undefined
                            };
                            
                            // Update tool state based on permission status
                            if (completed.status === 'approved') {
                                // Keep as running, waiting for actual tool execution
                                // Don't change state if tool already completed or errored
                                if (message.tool.state !== 'completed' && message.tool.state !== 'error' && message.tool.state !== 'running') {
                                    message.tool.state = 'running';
                                }
                            } else {
                                // denied or canceled
                                // Don't change to error if tool already completed successfully
                                if (message.tool.state !== 'error' && message.tool.state !== 'completed') {
                                    message.tool.state = 'error';
                                    message.tool.completedAt = completed.completedAt || Date.now();
                                    if (!message.tool.result && completed.reason) {
                                        message.tool.result = { error: completed.reason };
                                    }
                                }
                            }
                            
                            state.permissionIdToMessageId.set(permId, existingToolMessageId);
                            state.permissionIdToToolId.set(permId, matchingToolId);
                            changed.add(existingToolMessageId);
                            continue;
                        }
                    }
                    
                    // Skip if there's a matching tool in incoming messages
                    // When tool and permission arrive together, tool takes priority
                    const hasMatchingTool = incomingTools.some(tool => 
                        tool.name === completed.tool && deepEqual(tool.args, completed.arguments)
                    );
                    if (hasMatchingTool) {
                        console.log(`[REDUCER] Skipping permission ${permId} - matching tool in incoming messages`);
                        // Tool will be processed in Phase 2 with its own timestamp
                        continue;
                    }
                    
                    // Also skip if we already processed this as a pending request
                    const wasProcessedAsPending = agentState.requests && agentState.requests[permId];
                    if (wasProcessedAsPending) {
                        // We already created a message for this permission as pending, skip
                        continue;
                    }
                    
                    // Create a new message for it
                    let mid = allocateId();
                    let toolCall: ToolCall = {
                        name: completed.tool,
                        state: completed.status === 'approved' ? 'running' : 'error',  // Approved means waiting for tool execution
                        input: completed.arguments,
                        createdAt: completed.createdAt || Date.now(),
                        startedAt: null,
                        completedAt: completed.status === 'approved' ? null : (completed.completedAt || Date.now()),
                        description: null,
                        result: completed.status !== 'approved' && completed.reason ? { error: completed.reason } : undefined,
                        permission: {
                            id: permId,
                            status: completed.status,
                            reason: completed.reason || undefined
                        }
                    };

                    state.messages.set(mid, {
                        id: mid,
                        realID: null,
                        role: 'agent',
                        createdAt: completed.createdAt || Date.now(),
                        text: null,
                        tool: toolCall,
                        event: null,
                    });

                    state.permissionIdToMessageId.set(permId, mid);
                    changed.add(mid);
                }
            }
        }
    }

    //
    // Phase 1: Process non-sidechain user messages and text messages
    // 

    for (let msg of nonSidechainMessages) {
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
                realID: msg.id,
                role: 'user',
                createdAt: msg.createdAt,
                text: msg.content.text,
                tool: null,
                event: null,
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

            // Process text content only (tool calls handled in Phase 2)
            for (let c of msg.content) {
                if (c.type === 'text') {
                    let mid = allocateId();
                    state.messages.set(mid, {
                        id: mid,
                        realID: msg.id,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: c.text,
                        tool: null,
                        event: null,
                    });
                    changed.add(mid);
                }
            }
        }
    }

    //
    // Phase 2: Process non-sidechain tool calls
    //

    console.log(`[REDUCER] Phase 2: Processing tool calls`);
    for (let msg of nonSidechainMessages) {
        if (msg.role === 'agent') {
            for (let c of msg.content) {
                if (c.type === 'tool-call') {
                    // Check if we've already processed this tool
                    if (!state.toolIdToMessageId.has(c.id)) {
                        console.log(`[REDUCER] Processing new tool call ${c.id} (${c.name})`);
                        // Check if there's a permission-based message waiting for this tool
                        let existingMessageId: string | undefined;
                        let newestPermId: string | undefined;
                        let newestCreatedAt = -1;
                        
                        // Look for permission messages that match this tool (both pending and approved, prioritize newest)
                        for (const [permId, msgId] of state.permissionIdToMessageId) {
                            const message = state.messages.get(msgId);
                            // Match all permissions (including denied/canceled) since tools might have been executed anyway
                            if (message?.tool?.permission && 
                                message.tool.name === c.name &&
                                !state.permissionIdToToolId.has(permId)) {
                                // Check if arguments match (deep equality check)
                                const argsMatch = deepEqual(message.tool.input, c.input);
                                if (argsMatch) {
                                    // Check if this is newer than what we found
                                    if (message.createdAt > newestCreatedAt) {
                                        existingMessageId = msgId;
                                        newestPermId = permId;
                                        newestCreatedAt = message.createdAt;
                                    }
                                }
                            }
                        }
                        
                        // If we found a matching permission message, update it
                        if (existingMessageId && newestPermId) {
                            state.permissionIdToToolId.set(newestPermId, c.id);
                            state.toolIdToMessageId.set(c.id, existingMessageId);
                            
                            const message = state.messages.get(existingMessageId);
                            if (message?.tool) {
                                // Update the existing message with the tool details
                                // IMPORTANT: Never change message.createdAt - preserve original timestamp
                                message.realID = msg.id;
                                message.tool.description = c.description;
                                message.tool.startedAt = msg.createdAt;
                                changed.add(existingMessageId);
                            }
                        }
                        
                        // If no existing permission message, check if there's a matching permission in AgentState
                        // that was skipped in Phase 0 because this tool was in the incoming batch
                        if (!existingMessageId) {
                            let toolCall: ToolCall;
                            let foundSkippedPermission = false;
                            
                            // Check if there's a matching permission in AgentState that was skipped
                            if (agentState) {
                                // Check completed requests
                                if (agentState.completedRequests) {
                                    for (const [permId, completed] of Object.entries(agentState.completedRequests)) {
                                        if (completed.tool === c.name && deepEqual(completed.arguments, c.input)) {
                                            console.log(`[REDUCER] Found skipped permission ${permId} for tool ${c.id}`);
                                            // Create tool with permission info from AgentState
                                            toolCall = {
                                                name: c.name,
                                                state: completed.status === 'approved' ? 'running' : 'error',
                                                input: c.input,
                                                createdAt: msg.createdAt, // Use tool's timestamp
                                                startedAt: completed.status === 'approved' ? msg.createdAt : null,
                                                completedAt: completed.status === 'approved' ? null : msg.createdAt,
                                                description: c.description,
                                                result: completed.status !== 'approved' && completed.reason ? { error: completed.reason } : undefined,
                                                permission: {
                                                    id: permId,
                                                    status: completed.status,
                                                    reason: completed.reason || undefined
                                                }
                                            };
                                            foundSkippedPermission = true;
                                            
                                            // Track the permission mapping
                                            let mid = allocateId();
                                            state.messages.set(mid, {
                                                id: mid,
                                                realID: msg.id,
                                                role: 'agent',
                                                createdAt: msg.createdAt,
                                                text: null,
                                                tool: toolCall,
                                                event: null,
                                            });
                                            state.toolIdToMessageId.set(c.id, mid);
                                            state.permissionIdToToolId.set(permId, c.id);
                                            state.permissionIdToMessageId.set(permId, mid);
                                            changed.add(mid);
                                            existingMessageId = mid; // Mark as found
                                            break;
                                        }
                                    }
                                }
                                
                                // Check pending requests if not found in completed
                                if (!foundSkippedPermission && agentState.requests) {
                                    for (const [permId, request] of Object.entries(agentState.requests)) {
                                        if (request.tool === c.name && deepEqual(request.arguments, c.input)) {
                                            console.log(`[REDUCER] Found skipped pending permission ${permId} for tool ${c.id}`);
                                            // Create tool with pending permission
                                            toolCall = {
                                                name: c.name,
                                                state: 'running' as const,
                                                input: c.input,
                                                createdAt: msg.createdAt, // Use tool's timestamp
                                                startedAt: null,
                                                completedAt: null,
                                                description: c.description,
                                                result: undefined,
                                                permission: {
                                                    id: permId,
                                                    status: 'pending'
                                                }
                                            };
                                            foundSkippedPermission = true;
                                            
                                            // Track the permission mapping
                                            let mid = allocateId();
                                            state.messages.set(mid, {
                                                id: mid,
                                                realID: msg.id,
                                                role: 'agent',
                                                createdAt: msg.createdAt,
                                                text: null,
                                                tool: toolCall,
                                                event: null,
                                            });
                                            state.toolIdToMessageId.set(c.id, mid);
                                            state.permissionIdToToolId.set(permId, c.id);
                                            state.permissionIdToMessageId.set(permId, mid);
                                            changed.add(mid);
                                            existingMessageId = mid; // Mark as found
                                            break;
                                        }
                                    }
                                }
                            }
                            
                            // If still no permission found, create tool without permission
                            if (!foundSkippedPermission) {
                                console.log(`[REDUCER] No permission found for tool ${c.id}, creating tool WITHOUT permission`);
                                let mid = allocateId();
                                toolCall = {
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
                                    realID: msg.id,
                                    role: 'agent',
                                    createdAt: msg.createdAt,
                                    text: null,
                                    tool: toolCall,
                                    event: null,
                                });

                                // Map tool ID to message ID for result processing
                                state.toolIdToMessageId.set(c.id, mid);
                                changed.add(mid);
                            }
                        }
                    }
                }
            }
        }
    }

    //
    // Phase 3: Process non-sidechain tool results
    //

    for (let msg of nonSidechainMessages) {
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
                        tool: null,
                        event: null,
                    };
                    state.messages.set(mid, textMsg);
                    existingSidechain.push(textMsg);
                } else if (c.type === 'tool-call') {
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
                    let toolMsg: ReducerMessage = {
                        id: mid,
                        realID: msg.id,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: null,
                        tool: toolCall,
                        event: null,
                    };
                    state.messages.set(mid, toolMsg);
                    existingSidechain.push(toolMsg);

                    // Map for result processing
                    state.toolIdToMessageId.set(c.id, mid);
                } else if (c.type === 'tool-result') {
                    // Process tool result in sidechain
                    let messageId = state.toolIdToMessageId.get(c.tool_use_id);
                    if (messageId) {
                        let message = state.messages.get(messageId);
                        if (message && message.tool && message.tool.state === 'running') {
                            message.tool.state = c.is_error ? 'error' : 'completed';
                            message.tool.result = c.content;
                            message.tool.completedAt = msg.createdAt;
                        }
                    }
                }
            }
        }

        // Update the sidechain in state
        state.sidechains.set(msg.sidechainId, existingSidechain);

        // Update
        if (state.messageIds.has(msg.sidechainId)) {
            changed.add(state.messageIds.get(msg.sidechainId)!);
        }
    }

    //
    // Phase 5: Process mode-switch messages
    //

    for (let msg of nonSidechainMessages) {
        if (msg.role === 'event') {
            let mid = allocateId();
            state.messages.set(mid, {
                id: mid,
                realID: msg.id,
                role: 'agent',
                createdAt: msg.createdAt,
                event: msg.content,
                tool: null,
                text: null,
            });
            changed.add(mid);
        }
    }

    //
    // Collect changed messages (only root-level messages)
    //

    for (let id of changed) {
        let existing = state.messages.get(id);
        if (!existing) continue;

        let message = convertReducerMessageToMessage(existing, state);
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

function deepEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    
    if (keysA.length !== keysB.length) return false;
    
    for (const key of keysA) {
        if (!keysB.includes(key)) return false;
        if (!deepEqual(a[key], b[key])) return false;
    }
    
    return true;
}

function convertReducerMessageToMessage(reducerMsg: ReducerMessage, state: ReducerState): Message | null {
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
        let children = reducerMsg.realID ? state.sidechains.get(reducerMsg.realID) || [] : [];
        for (let child of children) {
            let childMessage = convertReducerMessageToMessage(child, state);
            if (childMessage) {
                childMessages.push(childMessage);
            }
        }

        return {
            id: reducerMsg.id,
            localId: null,
            createdAt: reducerMsg.createdAt,
            kind: 'tool-call',
            tool: { ...reducerMsg.tool },
            children: childMessages
        };
    } else if (reducerMsg.role === 'agent' && reducerMsg.event !== null) {
        return {
            id: reducerMsg.id,
            createdAt: reducerMsg.createdAt,
            kind: 'agent-event',
            event: reducerMsg.event
        };
    }

    return null;
}