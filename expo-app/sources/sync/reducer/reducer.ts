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

type ReducerMessage = {
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

    const normalizeThinkingChunk = (chunk: string): string => {
        const match = chunk.match(/^\*\*[^*]+\*\*\n([\s\S]*)$/);
        const body = match ? match[1] : chunk;
        // Some ACP providers stream thinking as word-per-line deltas (often `"\n"`-terminated).
        // Preserve paragraph breaks, but collapse single newlines into spaces for readability.
        return body
            .replace(/\r\n/g, '\n')
            .replace(/\n+/g, (m) => (m.length >= 2 ? '\n\n' : ' '));
    };

    const unwrapThinkingText = (text: string): string => {
        const match = text.match(/^\*Thinking\.\.\.\*\n\n\*([\s\S]*)\*$/);
        return match ? match[1] : text;
    };

    const wrapThinkingText = (body: string): string => `*Thinking...*\n\n*${body}*`;

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

    const isEmptyArray = (v: unknown): v is [] => Array.isArray(v) && v.length === 0;

    const coerceStreamingToolResultChunk = (value: unknown): { stdoutChunk?: string; stderrChunk?: string } | null => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const obj = value as Record<string, unknown>;
        const streamFlag = obj._stream === true;
        const stdoutChunk = typeof obj.stdoutChunk === 'string' ? obj.stdoutChunk : undefined;
        const stderrChunk = typeof obj.stderrChunk === 'string' ? obj.stderrChunk : undefined;
        if (!streamFlag && !stdoutChunk && !stderrChunk) return null;
        if (!stdoutChunk && !stderrChunk) return null;
        return { stdoutChunk, stderrChunk };
    };

    const mergeStreamingChunkIntoResult = (existing: unknown, chunk: { stdoutChunk?: string; stderrChunk?: string }): Record<string, unknown> => {
        const base: Record<string, unknown> =
            existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
        if (typeof chunk.stdoutChunk === 'string') {
            const prev = typeof base.stdout === 'string' ? base.stdout : '';
            base.stdout = prev + chunk.stdoutChunk;
        }
        if (typeof chunk.stderrChunk === 'string') {
            const prev = typeof base.stderr === 'string' ? base.stderr : '';
            base.stderr = prev + chunk.stderrChunk;
        }
        return base;
    };

    const mergeExistingStdStreamsIntoFinalResultIfMissing = (existing: unknown, next: unknown): unknown => {
        if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return next;
        if (!next || typeof next !== 'object' || Array.isArray(next)) return next;

        const prev = existing as Record<string, unknown>;
        const out = { ...(next as Record<string, unknown>) };

        if (typeof out.stdout !== 'string' && typeof prev.stdout === 'string') out.stdout = prev.stdout;
        if (typeof out.stderr !== 'string' && typeof prev.stderr === 'string') out.stderr = prev.stderr;
        return out;
    };

    const equalOptionalStringArrays = (a: unknown, b: unknown): boolean => {
        // Treat `undefined` / `null` / `[]` as equivalent “empty”.
        if (a == null || isEmptyArray(a)) {
            return b == null || isEmptyArray(b);
        }
        if (b == null || isEmptyArray(b)) {
            return a == null || isEmptyArray(a);
        }
        if (!Array.isArray(a) || !Array.isArray(b)) return false;
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    };

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

    //
    // Phase 0: Process AgentState permissions
    //

    const getCompletedAllowedTools = (completed: any): string[] | undefined => {
        const list = completed?.allowedTools ?? completed?.allowTools;
        return Array.isArray(list) ? list : undefined;
    };

    if (ENABLE_LOGGING) {
        console.log(`[REDUCER] Phase 0: Processing AgentState`);
    }
    if (agentState) {
        // Track permission ids where a newer pending request should override an older completed entry.
        const pendingOverridesCompleted = new Set<string>();

        // Process pending permission requests
        if (agentState.requests) {
            for (const [permId, request] of Object.entries(agentState.requests)) {
                // If this permission is also in completedRequests, prefer the newer one by timestamp.
                // Some agents can re-prompt with the same permission id (same toolCallId) even after
                // a previous approval was recorded; in that case we must surface the new pending request.
                const existingCompleted = agentState.completedRequests?.[permId];
                if (existingCompleted) {
                    const pendingCreatedAt = request.createdAt ?? 0;
                    const completedAt = existingCompleted.completedAt ?? existingCompleted.createdAt ?? 0;
                    const isNewerPending = pendingCreatedAt > completedAt;
                    if (!isNewerPending) {
                        continue;
                    }
                    pendingOverridesCompleted.add(permId);
                }

                // Check if we already have a message for this permission ID
                const existingMessageId = state.toolIdToMessageId.get(permId);
                if (existingMessageId) {
                    // Update existing tool message with permission info and latest arguments
                    const message = state.messages.get(existingMessageId);
                    if (message?.tool) {
                        if (ENABLE_LOGGING) {
                            console.log(`[REDUCER] Updating existing tool ${permId} with permission`);
                        }
                        let hasChanged = false;

                        // Update input only when it actually changed (keeps reducer idempotent).
                        // This still allows late-arriving fields (e.g. proposedExecpolicyAmendment)
                        // to update the existing permission message.
                        const inputUnchanged = compareToolCalls(
                            { name: request.tool, arguments: message.tool.input },
                            { name: request.tool, arguments: request.arguments }
                        );
                        if (!inputUnchanged) {
                            message.tool.input = request.arguments;
                            hasChanged = true;
                        }
                        if (!message.tool.permission) {
                            message.tool.permission = {
                                id: permId,
                                status: 'pending'
                            };
                            hasChanged = true;
                        }
                        if (hasChanged) {
                            changed.add(existingMessageId);
                        }
                    }
                } else {
                    if (ENABLE_LOGGING) {
                        console.log(`[REDUCER] Creating new message for permission ${permId}`);
                    }

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

                    // Store by permission ID (which will match tool ID)
                    state.toolIdToMessageId.set(permId, mid);

                    changed.add(mid);
                }

                // Store permission details for quick lookup
                state.permissions.set(permId, {
                    tool: request.tool,
                    arguments: request.arguments,
                    createdAt: request.createdAt || Date.now(),
                    status: 'pending'
                });
            }
        }

        // Process completed permission requests
        if (agentState.completedRequests) {
            for (const [permId, completed] of Object.entries(agentState.completedRequests)) {
                // If we have a newer pending request for this id, do not let the older completed entry win.
                if (pendingOverridesCompleted.has(permId)) {
                    continue;
                }
                // Check if we have a message for this permission ID
                const messageId = state.toolIdToMessageId.get(permId);
                if (messageId) {
                    const message = state.messages.get(messageId);
                    if (message?.tool) {
                        // Skip if tool has already started actual execution with approval
                        if (message.tool.startedAt && message.tool.permission?.status === 'approved') {
                            continue;
                        }

                        // Skip if permission already has date (came from tool result - preferred over agentState)
                        if (message.tool.permission?.date) {
                            continue;
                        }

                        // Check if we need to update ANY field
                        const needsUpdate = 
                            message.tool.permission?.status !== completed.status ||
                            message.tool.permission?.reason !== completed.reason ||
                            message.tool.permission?.mode !== completed.mode ||
                            !equalOptionalStringArrays(message.tool.permission?.allowedTools, getCompletedAllowedTools(completed)) ||
                            message.tool.permission?.decision !== completed.decision;

                        if (!needsUpdate) {
                            continue;
                        }

                        let hasChanged = false;

                        // Update permission status
                        if (!message.tool.permission) {
                            message.tool.permission = {
                                id: permId,
                                status: completed.status,
                                mode: completed.mode || undefined,
                                allowedTools: getCompletedAllowedTools(completed),
                                decision: completed.decision || undefined,
                                reason: completed.reason || undefined
                            };
                            hasChanged = true;
                        } else {
                            // Update all fields
                            message.tool.permission.status = completed.status;
                            message.tool.permission.mode = completed.mode || undefined;
                            message.tool.permission.allowedTools = getCompletedAllowedTools(completed);
                            message.tool.permission.decision = completed.decision || undefined;
                            if (completed.reason) {
                                message.tool.permission.reason = completed.reason;
                            }
                            hasChanged = true;
                        }

                        // Update tool state based on permission status
                        if (completed.status === 'approved') {
                            if (message.tool.state !== 'completed' && message.tool.state !== 'error' && message.tool.state !== 'running') {
                                message.tool.state = 'running';
                                hasChanged = true;
                            }
                        } else {
                            // denied or canceled
                            if (message.tool.state !== 'error' && message.tool.state !== 'completed') {
                                message.tool.state = 'error';
                                message.tool.completedAt = completed.completedAt || Date.now();
                                if (!message.tool.result && completed.reason) {
                                    message.tool.result = { error: completed.reason };
                                }
                                hasChanged = true;
                            }
                        }

                        // Update stored permission
                        state.permissions.set(permId, {
                            tool: completed.tool,
                            arguments: completed.arguments,
                            createdAt: completed.createdAt || Date.now(),
                            completedAt: completed.completedAt || undefined,
                            status: completed.status,
                            reason: completed.reason || undefined,
                            mode: completed.mode || undefined,
                            allowedTools: getCompletedAllowedTools(completed),
                            decision: completed.decision || undefined
                        });

                        if (hasChanged) {
                            changed.add(messageId);
                        }
                    }
                } else {
                    // No existing message - check if tool ID is in incoming messages
                    if (incomingToolIds.has(permId)) {
                        if (ENABLE_LOGGING) {
                            console.log(`[REDUCER] Storing permission ${permId} for incoming tool`);
                        }
                        // Store permission for when tool arrives in Phase 2
                        state.permissions.set(permId, {
                            tool: completed.tool,
                            arguments: completed.arguments,
                            createdAt: completed.createdAt || Date.now(),
                            completedAt: completed.completedAt || undefined,
                            status: completed.status,
                            reason: completed.reason || undefined
                        });
                        continue;
                    }

                    // Skip if already processed as pending
                    if (agentState.requests && agentState.requests[permId]) {
                        continue;
                    }

                    // Create a new message for completed permission without tool
                    let mid = allocateId();
                    let toolCall: ToolCall = {
                        name: completed.tool,
                        state: completed.status === 'approved' ? 'completed' : 'error',
                        input: completed.arguments,
                        createdAt: completed.createdAt || Date.now(),
                        startedAt: null,
                        completedAt: completed.completedAt || Date.now(),
                        description: null,
                        result: completed.status === 'approved'
                            ? 'Approved'
                            : (completed.reason ? { error: completed.reason } : undefined),
                        permission: {
                            id: permId,
                            status: completed.status,
                            reason: completed.reason || undefined,
                            mode: completed.mode || undefined,
                            allowedTools: getCompletedAllowedTools(completed),
                            decision: completed.decision || undefined
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

                    state.toolIdToMessageId.set(permId, mid);

                    // Store permission details
                    state.permissions.set(permId, {
                        tool: completed.tool,
                        arguments: completed.arguments,
                        createdAt: completed.createdAt || Date.now(),
                        completedAt: completed.completedAt || undefined,
                        status: completed.status,
                        reason: completed.reason || undefined,
                        mode: completed.mode || undefined,
                        allowedTools: getCompletedAllowedTools(completed),
                        decision: completed.decision || undefined
                    });

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
                meta: msg.meta,
            });

            // Track both localId and messageId
            if (msg.localId) {
                state.localIds.set(msg.localId, mid);
            }
            state.messageIds.set(msg.id, mid);

            changed.add(mid);
            lastMainThinkingMessageId = null;
            lastMainThinkingCreatedAt = null;
        } else if (msg.role === 'agent') {
            // Check if we've seen this agent message before
            if (state.messageIds.has(msg.id)) {
                continue;
            }

            // Mark this message as seen
            state.messageIds.set(msg.id, msg.id);

            // Process usage data if present
            if (msg.usage) {
                processUsageData(state, msg.usage, msg.createdAt);
            }

            // Process text and thinking content (tool calls handled in Phase 2)
            for (let c of msg.content) {
                if (c.type === 'text') {
                    let mid = allocateId();
                    state.messages.set(mid, {
                        id: mid,
                        realID: msg.id,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: c.text,
                        isThinking: false,
                        tool: null,
                        event: null,
                        meta: msg.meta,
                    });
                    changed.add(mid);
                    lastMainThinkingMessageId = null;
                    lastMainThinkingCreatedAt = null;
                } else if (c.type === 'thinking') {
                    const chunk = typeof c.thinking === 'string' ? normalizeThinkingChunk(c.thinking) : '';
                    if (!chunk.trim()) {
                        continue;
                    }

                    const prevThinkingId = lastMainThinkingMessageId;
                    const canAppendToPrevious =
                        prevThinkingId
                        && lastMainThinkingCreatedAt !== null
                        && msg.createdAt - lastMainThinkingCreatedAt < 120_000
                        && (() => {
                            const prev = state.messages.get(prevThinkingId);
                            return prev?.role === 'agent' && prev.isThinking && typeof prev.text === 'string';
                        })();

                    if (canAppendToPrevious) {
                        const prev = prevThinkingId ? state.messages.get(prevThinkingId) : null;
                        if (prev && typeof prev.text === 'string') {
                            const merged = unwrapThinkingText(prev.text) + chunk;
                            prev.text = wrapThinkingText(merged);
                            changed.add(prevThinkingId!);
                        }
                    } else {
                        let mid = allocateId();
                        state.messages.set(mid, {
                            id: mid,
                            realID: msg.id,
                            role: 'agent',
                            createdAt: msg.createdAt,
                            text: wrapThinkingText(chunk),
                            isThinking: true,
                            tool: null,
                            event: null,
                            meta: msg.meta,
                        });
                        changed.add(mid);
                        lastMainThinkingMessageId = mid;
                        lastMainThinkingCreatedAt = msg.createdAt;
                    }
                }
            }
        }
    }

    //
    // Phase 2: Process non-sidechain tool calls
    //

    if (ENABLE_LOGGING) {
        console.log(`[REDUCER] Phase 2: Processing tool calls`);
    }
    for (let msg of nonSidechainMessages) {
        if (msg.role === 'agent') {
            for (let c of msg.content) {
                if (c.type === 'tool-call') {
                    // Direct lookup by tool ID (since permission ID = tool ID now)
                    const existingMessageId = state.toolIdToMessageId.get(c.id);

                    if (existingMessageId) {
                        if (ENABLE_LOGGING) {
                            console.log(`[REDUCER] Found existing message for tool ${c.id}`);
                        }
                        // Update existing message with tool execution details
                        const message = state.messages.get(existingMessageId);
                        if (message?.tool) {
                            message.realID = msg.id;
                            message.tool.description = c.description;
                            message.tool.startedAt = msg.createdAt;

                            // Merge updated tool input (ACP providers can send late-arriving titles, locations,
                            // or rawInput in subsequent tool_call updates).
                            const incomingInput = c.input;
                            if (incomingInput !== undefined) {
                                const existingInput = message.tool.input;
                                const existingObj = existingInput && typeof existingInput === 'object' && !Array.isArray(existingInput)
                                    ? (existingInput as Record<string, unknown>)
                                    : null;
                                const incomingObj = incomingInput && typeof incomingInput === 'object' && !Array.isArray(incomingInput)
                                    ? (incomingInput as Record<string, unknown>)
                                    : null;

                                const merged =
                                    existingObj && incomingObj
                                        ? (() => {
                                            // Preserve existing fields (permission args are authoritative), but allow
                                            // ACP metadata (_acp) to update over time.
                                            const base = { ...incomingObj, ...existingObj };
                                            const existingAcp = existingObj._acp && typeof existingObj._acp === 'object' && !Array.isArray(existingObj._acp)
                                                ? (existingObj._acp as Record<string, unknown>)
                                                : null;
                                            const incomingAcp = incomingObj._acp && typeof incomingObj._acp === 'object' && !Array.isArray(incomingObj._acp)
                                                ? (incomingObj._acp as Record<string, unknown>)
                                                : null;
                                            if (incomingAcp) {
                                                base._acp = { ...(existingAcp ?? {}), ...incomingAcp };
                                            }
                                            return base;
                                        })()
                                        : incomingInput;

                                const inputUnchanged = compareToolCalls(
                                    { name: c.name, arguments: existingInput },
                                    { name: c.name, arguments: merged }
                                );
                                if (!inputUnchanged) {
                                    message.tool.input = merged;
                                }
                            }

                            if (!message.tool.permission && isPermissionRequestToolCall(c.id, message.tool.input)) {
                                message.tool.permission = { id: c.id, status: 'pending' };
                                message.tool.startedAt = null;
                            }

                            // If permission was approved and shown as completed (no tool), now it's running
                            if (message.tool.permission?.status === 'approved' && message.tool.state === 'completed') {
                                message.tool.state = 'running';
                                message.tool.completedAt = null;
                                message.tool.result = undefined;
                            }
                            changed.add(existingMessageId);

                            // Track TodoWrite tool inputs when updating existing messages
                            if (message.tool.name === 'TodoWrite' && message.tool.state === 'running' && message.tool.input?.todos) {
                                // Only update if this is newer than existing todos
                                if (!state.latestTodos || message.tool.createdAt > state.latestTodos.timestamp) {
                                    state.latestTodos = {
                                        todos: message.tool.input.todos,
                                        timestamp: message.tool.createdAt
                                    };
                                }
                            }
                        }
                    } else {
                        if (ENABLE_LOGGING) {
                            console.log(`[REDUCER] Creating new message for tool ${c.id}`);
                        }
                        // Check if there's a stored permission for this tool
                        const permission = state.permissions.get(c.id);

                        let toolCall: ToolCall = {
                            name: c.name,
                            state: 'running' as const,
                            input: permission ? permission.arguments : c.input,  // Use permission args if available
                            createdAt: permission ? permission.createdAt : msg.createdAt,  // Use permission timestamp if available
                            startedAt: msg.createdAt,
                            completedAt: null,
                            description: c.description,
                            result: undefined,
                        };

                        // Add permission info if found
                        if (permission) {
                            if (ENABLE_LOGGING) {
                                console.log(`[REDUCER] Found stored permission for tool ${c.id}`);
                            }
                            toolCall.permission = {
                                id: c.id,
                                status: permission.status,
                                reason: permission.reason,
                                mode: permission.mode,
                                allowedTools: permission.allowedTools,
                                decision: permission.decision
                            };

                            // Update state based on permission status
                            if (permission.status !== 'approved') {
                                toolCall.state = 'error';
                                toolCall.completedAt = permission.completedAt || msg.createdAt;
                                if (permission.reason) {
                                    toolCall.result = { error: permission.reason };
                                }
                            }
                        }

                        // Some providers persist pending permission requests as tool-call messages (without AgentState).
                        // Treat those tool-call inputs as pending permissions so the UI can render approval controls.
                        if (!permission && isPermissionRequestToolCall(c.id, c.input)) {
                            toolCall.startedAt = null;
                            toolCall.permission = { id: c.id, status: 'pending' };
                            state.permissions.set(c.id, {
                                tool: c.name,
                                arguments: c.input,
                                createdAt: msg.createdAt,
                                status: 'pending',
                            });
                        }

                        let mid = allocateId();
                        state.messages.set(mid, {
                            id: mid,
                            realID: msg.id,
                            role: 'agent',
                            createdAt: msg.createdAt,
                            text: null,
                            tool: toolCall,
                            event: null,
                            meta: msg.meta,
                        });

                        state.toolIdToMessageId.set(c.id, mid);
                        changed.add(mid);

                        // Track TodoWrite tool inputs
                        if (toolCall.name === 'TodoWrite' && toolCall.state === 'running' && toolCall.input?.todos) {
                            // Only update if this is newer than existing todos
                            if (!state.latestTodos || toolCall.createdAt > state.latestTodos.timestamp) {
                                state.latestTodos = {
                                    todos: toolCall.input.todos,
                                    timestamp: toolCall.createdAt
                                };
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

                    const streamChunk = coerceStreamingToolResultChunk(c.content);
                    if (streamChunk) {
                        message.tool.result = mergeStreamingChunkIntoResult(message.tool.result, streamChunk);
                        changed.add(messageId);
                        continue;
                    }

                    // Update tool state and result
                    message.tool.state = c.is_error ? 'error' : 'completed';
                    message.tool.result = mergeExistingStdStreamsIntoFinalResultIfMissing(message.tool.result, c.content);
                    message.tool.completedAt = msg.createdAt;

                    // Update permission data if provided by backend
                    if (c.permissions) {
                        // Merge with existing permission to preserve decision field from agentState
                        if (message.tool.permission) {
                            // Preserve existing decision if not provided in tool result
                            const existingDecision = message.tool.permission.decision;
                            message.tool.permission = {
                                ...message.tool.permission,
                                id: c.tool_use_id,
                                status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                date: c.permissions.date,
                                mode: c.permissions.mode,
                                allowedTools: c.permissions.allowedTools,
                                decision: c.permissions.decision || existingDecision
                            };
                        } else {
                            message.tool.permission = {
                                id: c.tool_use_id,
                                status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                date: c.permissions.date,
                                mode: c.permissions.mode,
                                allowedTools: c.permissions.allowedTools,
                                decision: c.permissions.decision
                            };
                        }
                    }

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
                meta: msg.meta,
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
                        isThinking: false,
                        tool: null,
                        event: null,
                        meta: msg.meta,
                    };
                    state.messages.set(mid, textMsg);
                    existingSidechain.push(textMsg);
                } else if (c.type === 'thinking') {
                    const chunk = typeof c.thinking === 'string' ? normalizeThinkingChunk(c.thinking) : '';
                    if (!chunk.trim()) {
                        continue;
                    }

                    const last = existingSidechain[existingSidechain.length - 1];
                    if (last && last.role === 'agent' && last.isThinking && typeof last.text === 'string') {
                        const merged = unwrapThinkingText(last.text) + chunk;
                        last.text = wrapThinkingText(merged);
                        changed.add(last.id);
                    } else {
                        let mid = allocateId();
                        let textMsg: ReducerMessage = {
                            id: mid,
                            realID: msg.id,
                            role: 'agent',
                            createdAt: msg.createdAt,
                            text: wrapThinkingText(chunk),
                            isThinking: true,
                            tool: null,
                            event: null,
                            meta: msg.meta,
                        };
                        state.messages.set(mid, textMsg);
                        existingSidechain.push(textMsg);
                    }
                } else if (c.type === 'tool-call') {
                    // Check if there's already a permission message for this tool
                    const existingPermissionMessageId = state.toolIdToMessageId.get(c.id);

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

                    // If there's a permission message, copy its permission info
                    if (existingPermissionMessageId) {
                        const permissionMessage = state.messages.get(existingPermissionMessageId);
                        if (permissionMessage?.tool?.permission) {
                            toolCall.permission = { ...permissionMessage.tool.permission };
                            // Update the permission message to show it's running
                            if (permissionMessage.tool.state !== 'completed' && permissionMessage.tool.state !== 'error') {
                                permissionMessage.tool.state = 'running';
                                permissionMessage.tool.startedAt = msg.createdAt;
                                permissionMessage.tool.description = c.description;
                                changed.add(existingPermissionMessageId);
                            }
                        }
                    }

                    let toolMsg: ReducerMessage = {
                        id: mid,
                        realID: msg.id,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: null,
                        tool: toolCall,
                        event: null,
                        meta: msg.meta,
                    };
                    state.messages.set(mid, toolMsg);
                    existingSidechain.push(toolMsg);

                    // Map sidechain tool separately to avoid overwriting permission mapping
                    state.sidechainToolIdToMessageId.set(c.id, mid);
                } else if (c.type === 'tool-result') {
                    // Process tool result in sidechain - update BOTH messages

                    // Update the sidechain tool message
                    let sidechainMessageId = state.sidechainToolIdToMessageId.get(c.tool_use_id);
                    if (sidechainMessageId) {
                        let sidechainMessage = state.messages.get(sidechainMessageId);
                        if (sidechainMessage && sidechainMessage.tool && sidechainMessage.tool.state === 'running') {
                            const streamChunk = coerceStreamingToolResultChunk(c.content);
                            if (streamChunk) {
                                sidechainMessage.tool.result = mergeStreamingChunkIntoResult(sidechainMessage.tool.result, streamChunk);
                            } else {
                                sidechainMessage.tool.state = c.is_error ? 'error' : 'completed';
                                sidechainMessage.tool.result = mergeExistingStdStreamsIntoFinalResultIfMissing(sidechainMessage.tool.result, c.content);
                                sidechainMessage.tool.completedAt = msg.createdAt;
                            }
                            
                            // Update permission data if provided by backend
                            if (c.permissions) {
                                // Merge with existing permission to preserve decision field from agentState
                                if (sidechainMessage.tool.permission) {
                                    const existingDecision = sidechainMessage.tool.permission.decision;
                                    sidechainMessage.tool.permission = {
                                        ...sidechainMessage.tool.permission,
                                        id: c.tool_use_id,
                                        status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                        date: c.permissions.date,
                                        mode: c.permissions.mode,
                                        allowedTools: c.permissions.allowedTools,
                                        decision: c.permissions.decision || existingDecision
                                    };
                                } else {
                                    sidechainMessage.tool.permission = {
                                        id: c.tool_use_id,
                                        status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                        date: c.permissions.date,
                                        mode: c.permissions.mode,
                                        allowedTools: c.permissions.allowedTools,
                                        decision: c.permissions.decision
                                    };
                                }
                            }

                            changed.add(sidechainMessageId);
                        }
                    }

                    // Also update the main permission message if it exists
                    let permissionMessageId = state.toolIdToMessageId.get(c.tool_use_id);
                    if (permissionMessageId) {
                        let permissionMessage = state.messages.get(permissionMessageId);
                        if (permissionMessage && permissionMessage.tool && permissionMessage.tool.state === 'running') {
                            const streamChunk = coerceStreamingToolResultChunk(c.content);
                            if (streamChunk) {
                                permissionMessage.tool.result = mergeStreamingChunkIntoResult(permissionMessage.tool.result, streamChunk);
                            } else {
                                permissionMessage.tool.state = c.is_error ? 'error' : 'completed';
                                permissionMessage.tool.result = mergeExistingStdStreamsIntoFinalResultIfMissing(permissionMessage.tool.result, c.content);
                                permissionMessage.tool.completedAt = msg.createdAt;
                            }
                            
                            // Update permission data if provided by backend
                            if (c.permissions) {
                                // Merge with existing permission to preserve decision field from agentState
                                if (permissionMessage.tool.permission) {
                                    const existingDecision = permissionMessage.tool.permission.decision;
                                    permissionMessage.tool.permission = {
                                        ...permissionMessage.tool.permission,
                                        id: c.tool_use_id,
                                        status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                        date: c.permissions.date,
                                        mode: c.permissions.mode,
                                        allowedTools: c.permissions.allowedTools,
                                        decision: c.permissions.decision || existingDecision
                                    };
                                } else {
                                    permissionMessage.tool.permission = {
                                        id: c.tool_use_id,
                                        status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                        date: c.permissions.date,
                                        mode: c.permissions.mode,
                                        allowedTools: c.permissions.allowedTools,
                                        decision: c.permissions.decision
                                    };
                                }
                            }
                            
                            changed.add(permissionMessageId);
                        }
                    }
                }
            }
        }

        // Update the sidechain in state
        state.sidechains.set(msg.sidechainId, existingSidechain);

        // Find the Task tool message that owns this sidechain and mark it as changed
        // msg.sidechainId is the realID of the Task message
        for (const [internalId, message] of state.messages) {
            if (message.realID === msg.sidechainId && message.tool) {
                changed.add(internalId);
                break;
            }
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
                meta: msg.meta,
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
