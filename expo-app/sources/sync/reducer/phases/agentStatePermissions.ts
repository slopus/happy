import { compareToolCalls } from '../../../utils/toolComparison';
import type { AgentState } from '../../storageTypes';
import type { ToolCall } from '../../typesMessage';
import { equalOptionalStringArrays } from '../helpers/arrays';
import type { ReducerState } from '../reducer';

export function runAgentStatePermissionsPhase(params: Readonly<{
    state: ReducerState;
    agentState?: AgentState | null;
    incomingToolIds: Set<string>;
    changed: Set<string>;
    allocateId: () => string;
    enableLogging: boolean;
}>): void {
    const { state, agentState, incomingToolIds, changed, allocateId, enableLogging } = params;

    //
    // Phase 0: Process AgentState permissions
    //

    const getCompletedAllowedTools = (completed: any): string[] | undefined => {
        const list = completed?.allowedTools ?? completed?.allowTools;
        return Array.isArray(list) ? list : undefined;
    };

    if (enableLogging) {
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
                        if (enableLogging) {
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
                    if (enableLogging) {
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
                        if (enableLogging) {
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
}

