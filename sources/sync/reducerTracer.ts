import { NormalizedMessage } from './typesRaw';

// Extended message type with sidechain ID
export type TracedMessage = NormalizedMessage & {
    sidechainId?: string;  // ID of the Task message this belongs to
}

// Tracer state for incremental processing
export interface TracerState {
    // Task tracking
    taskTools: Map<string, { messageId: string; prompt: string }>;  // toolId -> info
    promptToTaskId: Map<string, string>;  // prompt -> task message ID
    
    // Sidechain tracking
    uuidToSidechainId: Map<string, string>;  // uuid -> sidechain ID (task message ID)
    
    // Buffering for out-of-order messages
    orphanMessages: Map<string, NormalizedMessage[]>;  // parentUuid -> orphan messages waiting
    
    // Already processed
    processedIds: Set<string>;
}

// Create a new tracer state
export function createTracer(): TracerState {
    return {
        taskTools: new Map(),
        promptToTaskId: new Map(),
        uuidToSidechainId: new Map(),
        orphanMessages: new Map(),
        processedIds: new Set()
    };
}

// Get UUID from message content
function getMessageUuid(message: NormalizedMessage): string | null {
    if (message.role === 'agent' && message.content.length > 0) {
        const firstContent = message.content[0];
        if ('uuid' in firstContent && firstContent.uuid) {
            return firstContent.uuid;
        }
    }
    return null;
}

// Get parent UUID from message content
function getParentUuid(message: NormalizedMessage): string | null {
    if (message.role === 'agent' && message.content.length > 0) {
        const firstContent = message.content[0];
        if ('parentUUID' in firstContent) {
            return firstContent.parentUUID;
        }
    }
    return null;
}

// Process orphan messages recursively
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

// Main tracer function
export function traceMessages(state: TracerState, messages: NormalizedMessage[]): TracedMessage[] {
    const results: TracedMessage[] = [];
    
    for (const message of messages) {
        // Skip if already processed
        if (state.processedIds.has(message.id)) {
            continue;
        }
        
        // Extract Task tools
        if (message.role === 'agent') {
            for (const content of message.content) {
                if (content.type === 'tool-call' && content.name === 'Task') {
                    if (content.input && typeof content.input === 'object' && 'prompt' in content.input) {
                        // Use message.id as the key and store both the tool ID and prompt
                        state.taskTools.set(message.id, {
                            messageId: message.id,
                            prompt: content.input.prompt
                        });
                        state.promptToTaskId.set(content.input.prompt, message.id);
                    }
                }
            }
        }
        
        // Check if non-sidechain - return immediately
        if (!message.isSidechain) {
            state.processedIds.add(message.id);
            const tracedMessage: TracedMessage = {
                ...message
            };
            results.push(tracedMessage);
            continue;
        }
        
        // Handle sidechain messages
        const uuid = getMessageUuid(message);
        const parentUuid = getParentUuid(message);
        
        // Check if this is a sidechain root (matches a Task prompt)
        let isSidechainRoot = false;
        let sidechainId: string | undefined;
        
        // Check for sidechain content type (explicit sidechain marker)
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
            // This is a sidechain root
            state.processedIds.add(message.id);
            state.uuidToSidechainId.set(uuid, sidechainId);
            
            const tracedMessage: TracedMessage = {
                ...message,
                sidechainId
            };
            results.push(tracedMessage);
            
            // Process any orphans waiting for this UUID
            const orphanResults = processOrphans(state, uuid, sidechainId);
            results.push(...orphanResults);
        } else if (parentUuid) {
            // This message has a parent
            const parentSidechainId = state.uuidToSidechainId.get(parentUuid);
            
            if (parentSidechainId) {
                // Parent is known - assign same sidechain ID
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
                // Parent unknown - buffer as orphan
                const orphans = state.orphanMessages.get(parentUuid) || [];
                orphans.push(message);
                state.orphanMessages.set(parentUuid, orphans);
            }
        } else {
            // No parent UUID and not a sidechain root - return as-is
            state.processedIds.add(message.id);
            const tracedMessage: TracedMessage = {
                ...message
            };
            results.push(tracedMessage);
        }
    }
    
    return results;
}