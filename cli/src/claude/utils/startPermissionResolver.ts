import { logger } from "@/lib";
import { SDKAssistantMessage, SDKMessage, SDKUserMessage } from "../sdk";
import { PLAN_FAKE_REJECT, PLAN_FAKE_RESTART } from "../sdk/prompts";
import { Session } from "../session";
import { startPermissionServerV2 } from "./startPermissionServerV2";

export async function startPermissionResolver(session: Session) {

    let toolCalls: { id: string, name: string, input: any, used: boolean }[] = [];

    let requests = new Map<string, (response: { approved: boolean, reason?: string }) => void>();
    const server = await startPermissionServerV2(async (request) => {

        // Should not happent
        const id = resolveToolCallId(request.name, request.arguments);
        if (!id) {
            const error = `Could not resolve tool call ID for permission request: ${request.name}`;
            throw new Error(error);
        }

        // Hack for exit_plan_mode
        let promise = new Promise<{ approved: boolean, reason?: string }>((resolve) => {
            if (request.name === 'exit_plan_mode') {
                // Intercept exit_plan_mode approval
                const wrappedResolve = (response: { approved: boolean, reason?: string }) => {
                    if (response.approved) {
                        // Inject the approval message at the beginning of the queue
                        session.scanner.onRemoteUserMessageForDeduplication(PLAN_FAKE_RESTART); // Deduplicate
                        session.queue.unshift(PLAN_FAKE_RESTART, 'default');
                        resolve({ approved: false, reason: PLAN_FAKE_REJECT });
                    } else {
                        resolve(response);
                    }
                };
                requests.set(id, wrappedResolve);
            } else {
                requests.set(id, resolve);
            }
        });

        let timeout = setTimeout(async () => {
            // Interrupt claude execution on permission timeout
            logger.debug('Permission timeout - attempting to interrupt Claude');
            // const interrupted = await interruptController.interrupt();
            // if (interrupted) {
            //     logger.debug('Claude interrupted successfully');
            // }

            // Delete callback we are awaiting on
            requests.delete(id);

            // Move the permission request to completedRequests with canceled status
            session.client.updateAgentState((currentState) => {
                const request = currentState.requests?.[id];
                if (!request) return currentState;

                let r = { ...currentState.requests };
                delete r[id];

                return ({
                    ...currentState,
                    requests: r,
                    completedRequests: {
                        ...currentState.completedRequests,
                        [id]: {
                            ...request,
                            completedAt: Date.now(),
                            status: 'canceled',
                            reason: 'Timeout'
                        }
                    }
                });
            });
        }, 1000 * 60 * 4.5) // 4.5 minutes, 30 seconds before max timeout
        logger.debug('Permission request' + id + ' ' + JSON.stringify(request));

        // Send push notification for permission request
        try {
            await session.api.push().sendToAllDevices(
                'Permission Request',
                `Claude wants to use ${request.name}`,
                {
                    sessionId: session.client.sessionId,
                    requestId: id,
                    tool: request.name,
                    type: 'permission_request'
                }
            );
            logger.debug('Push notification sent for permission request');
        } catch (error) {
            logger.debug('Failed to send push notification:', error);
        }

        session.client.updateAgentState((currentState) => ({
            ...currentState,
            requests: {
                ...currentState.requests,
                [id]: {
                    tool: request.name,
                    arguments: request.arguments,
                    createdAt: Date.now()
                }
            }
        }));

        // Clear timeout when permission is resolved
        promise.then(() => clearTimeout(timeout)).catch(() => clearTimeout(timeout));

        return promise;
    });

    session.client.setHandler<PermissionResponse, void>('permission', async (message) => {
        logger.debug('Permission response' + JSON.stringify(message));
        const id = message.id;
        const resolve = requests.get(id);
        if (resolve) {
            resolve({ approved: message.approved, reason: message.reason });
            requests.delete(id);
        } else {
            logger.debug('Permission request stale, likely timed out');
            return;
        }

        // Move processed request to completedRequests
        session.client.updateAgentState((currentState) => {
            const request = currentState.requests?.[id];
            if (!request) return currentState;

            let r = { ...currentState.requests };
            delete r[id];

            // Check for PLAN_FAKE_REJECT to report as success
            const isExitPlanModeSuccess = request.tool === 'exit_plan_mode' &&
                !message.approved &&
                message.reason === PLAN_FAKE_REJECT;

            return ({
                ...currentState,
                requests: r,
                completedRequests: {
                    ...currentState.completedRequests,
                    [id]: {
                        ...request,
                        completedAt: Date.now(),
                        status: isExitPlanModeSuccess ? 'approved' : (message.approved ? 'approved' : 'denied'),
                        reason: isExitPlanModeSuccess ? 'Plan approved' : message.reason
                    }
                }
            });
        });
    });

    const resolveToolCallId = (name: string, args: any): string | null => {
        // Search in reverse (most recent first)
        for (let i = toolCalls.length - 1; i >= 0; i--) {
            const call = toolCalls[i];
            if (call.name === name && deepEqual(call.input, args)) {
                if (call.used) {
                    return null;
                }
                // Found unused match - mark as used and return
                call.used = true;
                return call.id;
            }
        }

        // No match found
        return null;
    };

    function reset() {
        toolCalls = [];
    }

    function onMessage(message: SDKMessage) {
        if (message.type === 'assistant') {
            const assistantMsg = message as SDKAssistantMessage;
            if (assistantMsg.message && assistantMsg.message.content) {
                for (const block of assistantMsg.message.content) {
                    if (block.type === 'tool_use') {
                        toolCalls.push({
                            id: block.id!,
                            name: block.name!,
                            input: block.input,
                            used: false
                        });
                    }
                }
            }
        }
        if (message.type === 'user') {
            const userMsg = message as SDKUserMessage;

            // Check content for tool_result blocks
            if (userMsg.message && userMsg.message.content && Array.isArray(userMsg.message.content)) {
                for (const block of userMsg.message.content) {
                    if (block.type === 'tool_result' && block.tool_use_id) {
                        const toolCall = toolCalls.find(tc => tc.id === block.tool_use_id);
                        if (toolCall && !toolCall.used) {
                            toolCall.used = true;
                        }
                    }
                }
            }
        }
    }

    return {
        server,
        reset,
        onMessage
    }
}

interface PermissionResponse {
    id: string;
    approved: boolean;
    reason?: string;
}