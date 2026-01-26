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
 * **Phase 0.5: Message-to-Event Conversion**
 *   - Parses messages to check if they should be converted to events
 *   - Converts matching messages to events immediately
 *   - Converted messages skip all subsequent processing phases
 *   - Supports user commands, tool results, and metadata-driven conversions
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
import { AgentEvent, NormalizedMessage, UsageData } from "../typesRaw";
import { createTracer, traceMessages, TracerState } from "./reducerTracer";
import { AgentState } from "../storageTypes";
import { MessageMeta } from "../typesMessageMeta";
import { compareToolCalls } from "../../utils/toolComparison";
import { runMessageToEventConversion } from "./phases/messageToEventConversion";
import { runAgentStatePermissionsPhase } from "./phases/agentStatePermissions";
import { runUserAndTextPhase } from "./phases/userAndText";
import { runToolCallsPhase } from "./phases/toolCalls";
import { runToolResultsPhase } from "./phases/toolResults";
import { runSidechainsPhase } from "./phases/sidechains";
import { runModeSwitchEventsPhase } from "./phases/modeSwitchEvents";
import { equalOptionalStringArrays } from "./helpers/arrays";
import { coerceStreamingToolResultChunk, mergeExistingStdStreamsIntoFinalResultIfMissing, mergeStreamingChunkIntoResult } from "./helpers/streamingToolResult";
import { normalizeThinkingChunk, unwrapThinkingText, wrapThinkingText } from "./helpers/thinkingText";

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function firstString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function extractPermissionRequestId(input: unknown): string | null {
    const obj = asRecord(input);
    if (!obj) return null;

    const direct =
        firstString(obj.permissionId) ??
        firstString(obj.toolCallId) ??
        null;
    if (direct) return direct;

    const toolCall = asRecord(obj.toolCall);
    if (!toolCall) return null;

    return (
        firstString(toolCall.permissionId) ??
        firstString(toolCall.toolCallId) ??
        null
    );
}

function isPermissionRequestToolCall(toolId: string, input: unknown): boolean {
    const extracted = extractPermissionRequestId(input);
    if (!extracted || extracted !== toolId) return false;

    const obj = asRecord(input);
    const toolCall = obj ? asRecord(obj.toolCall) : null;
    const status = firstString(toolCall?.status) ?? firstString(obj?.status) ?? null;

    // Only treat as a permission request when it looks pending.
    return status === 'pending' || toolCall !== null;
}

export type ReducerMessage = {
    id: string;
    realID: string | null;
    createdAt: number;
    role: 'user' | 'agent';
    text: string | null;
    isThinking?: boolean;
    event: AgentEvent | null;
    tool: ToolCall | null;
    meta?: MessageMeta;
}

type StoredPermission = {
    tool: string;
    arguments: any;
    createdAt: number;
    completedAt?: number;
    status: 'pending' | 'approved' | 'denied' | 'canceled';
    reason?: string;
    mode?: string;
    allowedTools?: string[];
    // Backward-compatible field name used by some clients/agents.
    allowTools?: string[];
    decision?: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
};

export type ReducerState = {
    toolIdToMessageId: Map<string, string>; // toolId/permissionId -> messageId (since they're the same now)
    sidechainToolIdToMessageId: Map<string, string>; // toolId -> sidechain messageId (for dual tracking)
    permissions: Map<string, StoredPermission>; // Store permission details by ID for quick lookup
    localIds: Map<string, string>;
    messageIds: Map<string, string>; // originalId -> internalId
    messages: Map<string, ReducerMessage>;
    sidechains: Map<string, ReducerMessage[]>;
    tracerState: TracerState; // Tracer state for sidechain processing
    latestTodos?: {
        todos: Array<{
            content: string;
            status: 'pending' | 'in_progress' | 'completed';
            priority: 'high' | 'medium' | 'low';
            id: string;
        }>;
        timestamp: number;
    };
    latestUsage?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
        timestamp: number;
    };
};

export function createReducer(): ReducerState {
    return {
        toolIdToMessageId: new Map(),
        sidechainToolIdToMessageId: new Map(),
        permissions: new Map(),
        messages: new Map(),
        localIds: new Map(),
        messageIds: new Map(),
        sidechains: new Map(),
        tracerState: createTracer()
    }
};

const ENABLE_LOGGING = false;

export type ReducerResult = {
    messages: Message[];
    todos?: Array<{
        content: string;
        status: 'pending' | 'in_progress' | 'completed';
        priority: 'high' | 'medium' | 'low';
        id: string;
    }>;
    usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
    };
    hasReadyEvent?: boolean;
};

export function reducer(state: ReducerState, messages: NormalizedMessage[], agentState?: AgentState | null): ReducerResult {
    if (ENABLE_LOGGING) {
        console.log(`[REDUCER] Called with ${messages.length} messages, agentState: ${agentState ? 'YES' : 'NO'}`);
        if (agentState?.requests) {
            console.log(`[REDUCER] AgentState has ${Object.keys(agentState.requests).length} pending requests`);
        }
        if (agentState?.completedRequests) {
            console.log(`[REDUCER] AgentState has ${Object.keys(agentState.completedRequests).length} completed requests`);
        }
    }

    let newMessages: Message[] = [];
    let changed: Set<string> = new Set();
    let hasReadyEvent = false;

    const sidechainMessageIds = new Set<string>();
    for (const chain of state.sidechains.values()) {
        for (const m of chain) sidechainMessageIds.add(m.id);
    }

    let lastMainThinkingMessageId: string | null = null;
    let lastMainThinkingCreatedAt: number | null = null;
    for (const [mid, m] of state.messages) {
        if (sidechainMessageIds.has(mid)) continue;
        if (m.role !== 'agent' || !m.isThinking || typeof m.text !== 'string') continue;
        if (lastMainThinkingCreatedAt === null || m.createdAt > lastMainThinkingCreatedAt) {
            lastMainThinkingMessageId = mid;
            lastMainThinkingCreatedAt = m.createdAt;
        }
    }


    // First, trace all messages to identify sidechains
    const tracedMessages = traceMessages(state.tracerState, messages);

    // Separate sidechain and non-sidechain messages
    let nonSidechainMessages = tracedMessages.filter(msg => !msg.sidechainId);
    const sidechainMessages = tracedMessages.filter(msg => msg.sidechainId);

    //
    const conversion = runMessageToEventConversion({
        state,
        nonSidechainMessages,
        changed,
        allocateId,
        enableLogging: ENABLE_LOGGING,
    });
	    nonSidechainMessages = conversion.nonSidechainMessages;
	    const incomingToolIds = conversion.incomingToolIds;
	    hasReadyEvent = hasReadyEvent || conversion.hasReadyEvent;

	    runAgentStatePermissionsPhase({
	        state,
	        agentState,
	        incomingToolIds,
	        changed,
	        allocateId,
	        enableLogging: ENABLE_LOGGING,
	    });

	    const phase1 = runUserAndTextPhase({
	        state,
	        nonSidechainMessages,
	        changed,
	        allocateId,
	        processUsageData,
	        lastMainThinkingMessageId,
	        lastMainThinkingCreatedAt,
	    });
	    lastMainThinkingMessageId = phase1.lastMainThinkingMessageId;
	    lastMainThinkingCreatedAt = phase1.lastMainThinkingCreatedAt;

	    runToolCallsPhase({
	        state,
	        nonSidechainMessages,
	        changed,
	        allocateId,
	        enableLogging: ENABLE_LOGGING,
	        isPermissionRequestToolCall,
	    });

	    runToolResultsPhase({
	        state,
	        nonSidechainMessages,
	        changed,
	    });

    //
    // Phase 4: Process sidechains and store them in state
    //

    runSidechainsPhase({
        state,
        sidechainMessages,
        changed,
        allocateId,
    });

    runModeSwitchEventsPhase({
        state,
        nonSidechainMessages,
        changed,
        allocateId,
    });

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

    //
    // Debug changes
    //

    if (ENABLE_LOGGING) {
        console.log(JSON.stringify(messages, null, 2));
        console.log(`[REDUCER] Changed messages: ${changed.size}`);
    }

    return {
        messages: newMessages,
        todos: state.latestTodos?.todos,
        usage: state.latestUsage ? {
            inputTokens: state.latestUsage.inputTokens,
            outputTokens: state.latestUsage.outputTokens,
            cacheCreation: state.latestUsage.cacheCreation,
            cacheRead: state.latestUsage.cacheRead,
            contextSize: state.latestUsage.contextSize
        } : undefined,
        hasReadyEvent: hasReadyEvent || undefined
    };
}

//
// Helpers
//

function allocateId() {
    return Math.random().toString(36).substring(2, 15);
}

function processUsageData(state: ReducerState, usage: UsageData, timestamp: number) {
    // Only update if this is newer than the current latest usage
    if (!state.latestUsage || timestamp > state.latestUsage.timestamp) {
        state.latestUsage = {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheCreation: usage.cache_creation_input_tokens || 0,
            cacheRead: usage.cache_read_input_tokens || 0,
            contextSize: (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) + usage.input_tokens,
            timestamp: timestamp
        };
    }
}


function convertReducerMessageToMessage(reducerMsg: ReducerMessage, state: ReducerState): Message | null {
    if (reducerMsg.role === 'user' && reducerMsg.text !== null) {
        return {
            id: reducerMsg.id,
            localId: null,
            createdAt: reducerMsg.createdAt,
            kind: 'user-text',
            text: reducerMsg.text,
            ...(reducerMsg.meta?.displayText && { displayText: reducerMsg.meta.displayText }),
            meta: reducerMsg.meta
        };
    } else if (reducerMsg.role === 'agent' && reducerMsg.text !== null) {
        return {
            id: reducerMsg.id,
            localId: null,
            createdAt: reducerMsg.createdAt,
            kind: 'agent-text',
            text: reducerMsg.text,
            ...(reducerMsg.isThinking && { isThinking: true }),
            meta: reducerMsg.meta
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
            children: childMessages,
            meta: reducerMsg.meta
        };
    } else if (reducerMsg.role === 'agent' && reducerMsg.event !== null) {
        return {
            id: reducerMsg.id,
            createdAt: reducerMsg.createdAt,
            kind: 'agent-event',
            event: reducerMsg.event,
            meta: reducerMsg.meta
        };
    }

    return null;
}
