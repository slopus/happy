// ============================================================================
// Reducer Tracer - Message Relationship Tracking for Sidechains
// ============================================================================
//
// This module is responsible for tracking relationships between messages,
// specifically focusing on linking sidechain messages to their originating
// Task tool calls. This is crucial for understanding the flow of AI agent
// interactions where Task tools spawn separate execution contexts (sidechains).
//
// Key Concepts:
// -------------
// 1. Task Tools: When the AI uses a Task tool, it initiates a separate
//    execution context that produces its own message stream (a sidechain).
//
// 2. Sidechains: These are message sequences that occur in a separate context
//    but need to be linked back to the Task that spawned them. Messages in
//    sidechains have isSidechain=true.
//
// 3. Message Relationships: Each message can have:
//    - A UUID: Unique identifier for the message
//    - A parentUUID: Reference to its parent message (for nested responses)
//    - A sidechainId: The message ID of the Task tool call that spawned it
//
// How It Works:
// -------------
// 1. Task Detection: When a Task tool call is encountered, we store it in
//    taskTools indexed by the message ID (not the tool ID). We also index
//    by prompt for quick lookup when matching sidechain roots.
//
// 2. Sidechain Root Matching: When a sidechain message arrives with a prompt
//    that matches a known Task prompt, it's identified as a sidechain root
//    and assigned the Task's message ID as its sidechainId.
//
// 3. Parent-Child Linking: Sidechain messages can reference parent messages
//    via parentUUID. Children inherit the sidechainId from their parent.
//
// 4. Orphan Handling: Messages may arrive out of order. If a child arrives
//    before its parent, it's buffered as an "orphan" until the parent
//    arrives, then processed recursively.
//
// 5. Propagation: Once a sidechain root is identified, all its descendants
//    (direct children and their children) inherit the same sidechainId.
//
// Example Flow:
// -------------
// 1. Message "msg1" contains Task tool call with prompt "Search for files"
// 2. Sidechain message "sc1" arrives with type="sidechain" and same prompt
//    -> sc1 gets sidechainId="msg1"
// 3. Message "sc2" arrives with parentUUID="sc1"
//    -> sc2 inherits sidechainId="msg1" from its parent
// 4. Any orphans waiting for "sc1" or "sc2" are processed recursively
//
// This tracking enables the UI to group related messages together and show
// the complete context of Task executions, even when messages arrive out
// of order or from different execution contexts.
//
// ============================================================================

import { NormalizedMessage } from '../typesRaw';

// Extended message type with sidechain ID for tracking message relationships
export type TracedMessage = NormalizedMessage & {
    sidechainId?: string;  // ID of the Task message that initiated this sidechain
}

// Tracer state for tracking message relationships and sidechain processing
export interface TracerState {
    // Task tracking - stores Task tool calls by their message ID
    taskTools: Map<string, { messageId: string; prompt: string }>;  // messageId -> Task info
    promptToTaskId: Map<string, string>;  // prompt -> task message ID (for matching sidechains)
    
    // Sidechain tracking - maps message UUIDs to their originating Task message ID
    uuidToSidechainId: Map<string, string>;  // uuid -> sidechain ID (originating task message ID)
    
    // Buffering for out-of-order messages that arrive before their parent
    orphanMessages: Map<string, NormalizedMessage[]>;  // parentUuid -> orphan messages waiting for parent
    
    // Track already processed messages to avoid duplicates
    processedIds: Set<string>;
}

// Create a new tracer state with empty collections
export function createTracer(): TracerState {
    return {
        taskTools: new Map(),
        promptToTaskId: new Map(),
        uuidToSidechainId: new Map(),
        orphanMessages: new Map(),
        processedIds: new Set()
    };
}

// Extract UUID from the first content item of an agent message
function getMessageUuid(message: NormalizedMessage): string | null {
    if (message.role === 'agent' && message.content.length > 0) {
        const firstContent = message.content[0];
        if ('uuid' in firstContent && firstContent.uuid) {
            return firstContent.uuid;
        }
    }
    return null;
}

// Extract parent UUID from the first content item of an agent message
function getParentUuid(message: NormalizedMessage): string | null {
    if (message.role === 'agent' && message.content.length > 0) {
        const firstContent = message.content[0];
        if ('parentUUID' in firstContent) {
            return firstContent.parentUUID;
        }
    }
    return null;
}

// Process orphan messages recursively when their parent becomes available
function processOrphans(state: TracerState, parentUuid: string, sidechainId: string): TracedMessage[] {
    const results: TracedMessage[] = [];
    const orphans = state.orphanMessages.get(parentUuid);
    
    if (!orphans) {
        return results;
    }
    
    // Remove from orphan map
    state.orphanMessages.delete(parentUuid);
    
    // Process each orphan
    for (const orphan of orphans) {
        const uuid = getMessageUuid(orphan);
        
        // Mark as processed
        state.processedIds.add(orphan.id);
        
        // Assign sidechain ID
        if (uuid) {
            state.uuidToSidechainId.set(uuid, sidechainId);
        }
        
        // Create traced message
        const tracedMessage: TracedMessage = {
            ...orphan,
            sidechainId
        };
        results.push(tracedMessage);
        
        // Recursively process any orphans waiting for this message
        if (uuid) {
            const childOrphans = processOrphans(state, uuid, sidechainId);
            results.push(...childOrphans);
        }
    }
    
    return results;
}

// Main tracer function - processes messages and assigns sidechain IDs based on Task relationships
export function traceMessages(state: TracerState, messages: NormalizedMessage[]): TracedMessage[] {
    const results: TracedMessage[] = [];
    
    for (const message of messages) {
        // Skip if already processed
        if (state.processedIds.has(message.id)) {
            continue;
        }
        
        // Extract Task tools and index them by message ID for later sidechain matching
        if (message.role === 'agent') {
            for (const content of message.content) {
                if (content.type === 'tool-call' && content.name === 'Task') {
                    if (content.input && typeof content.input === 'object' && 'prompt' in content.input) {
                        // Store Task info indexed by message ID (not tool ID)
                        state.taskTools.set(message.id, {
                            messageId: message.id,
                            prompt: content.input.prompt
                        });
                        state.promptToTaskId.set(content.input.prompt, message.id);
                    }
                }
            }
        }
        
        // Non-sidechain messages are returned immediately without sidechain ID
        if (!message.isSidechain) {
            state.processedIds.add(message.id);
            const tracedMessage: TracedMessage = {
                ...message
            };
            results.push(tracedMessage);
            continue;
        }
        
        // Handle sidechain messages - these need to be linked to their originating Task
        const uuid = getMessageUuid(message);
        const parentUuid = getParentUuid(message);
        
        // Check if this is a sidechain root by matching its prompt to a known Task
        let isSidechainRoot = false;
        let sidechainId: string | undefined;
        
        // Look for sidechain content type with a prompt that matches a Task
        if (message.role === 'agent') {
            for (const content of message.content) {
                if (content.type === 'sidechain' && content.prompt) {
                    const taskId = state.promptToTaskId.get(content.prompt);
                    if (taskId) {
                        isSidechainRoot = true;
                        sidechainId = taskId;
                        break;
                    }
                }
            }
        }
        
        if (isSidechainRoot && uuid && sidechainId) {
            // This is a sidechain root - mark it and process any waiting orphans
            state.processedIds.add(message.id);
            state.uuidToSidechainId.set(uuid, sidechainId);
            
            const tracedMessage: TracedMessage = {
                ...message,
                sidechainId
            };
            results.push(tracedMessage);
            
            // Process any orphan messages that were waiting for this parent
            const orphanResults = processOrphans(state, uuid, sidechainId);
            results.push(...orphanResults);
        } else if (parentUuid) {
            // This message has a parent - check if parent's sidechain ID is known
            const parentSidechainId = state.uuidToSidechainId.get(parentUuid);
            
            if (parentSidechainId) {
                // Parent is known - inherit the same sidechain ID
                state.processedIds.add(message.id);
                if (uuid) {
                    state.uuidToSidechainId.set(uuid, parentSidechainId);
                }
                
                const tracedMessage: TracedMessage = {
                    ...message,
                    sidechainId: parentSidechainId
                };
                results.push(tracedMessage);
                
                // Process any orphans waiting for this UUID
                if (uuid) {
                    const orphanResults = processOrphans(state, uuid, parentSidechainId);
                    results.push(...orphanResults);
                }
            } else {
                // Parent not yet processed - buffer this message as an orphan
                const orphans = state.orphanMessages.get(parentUuid) || [];
                orphans.push(message);
                state.orphanMessages.set(parentUuid, orphans);
            }
        } else {
            // Sidechain message with no parent and not a root - process as standalone
            state.processedIds.add(message.id);
            const tracedMessage: TracedMessage = {
                ...message
            };
            results.push(tracedMessage);
        }
    }
    
    return results;
}