import { z } from "zod";
import { type Fastify } from "../types";
import { log } from "@/utils/log";
import { invokeUserRpc } from "../socket/rpcRegistry";

const bridgedVoiceToolNameSchema = z.enum([
    'messageClaudeCode',
    'processPermissionRequest',
    'listSessions',
    'switchSession',
    'createSession',
    'changeSessionSettings',
    'getSessionStatus',
    'getLatestAssistantReply',
    'deleteSessionTool',
    'navigateHome',
    'endVoiceConversation',
] as const);

export function voiceRoutes(app: Fastify) {
    app.post('/v1/voice/tool-call', {
        schema: {
            headers: z.object({
                'x-voice-bridge-key': z.string().optional(),
                authorization: z.string().optional(),
            }).passthrough(),
            body: z.object({
                gatewaySessionId: z.string(),
                userId: z.string(),
                appSessionId: z.string().optional(),
                functionName: bridgedVoiceToolNameSchema,
                parameters: z.record(z.any()).optional(),
            }),
            response: {
                200: z.object({
                    result: z.string(),
                }),
                401: z.object({
                    error: z.string(),
                }),
                503: z.object({
                    error: z.string(),
                }),
            }
        }
    }, async (request, reply) => {
        const bridgeKey = process.env.VOICE_TOOL_BRIDGE_KEY;
        const requestKey = (request.headers['x-voice-bridge-key'] as string | undefined)
            || (request.headers.authorization?.replace(/^Bearer\s+/i, '').trim());

        if (!bridgeKey || !requestKey || requestKey !== bridgeKey) {
            return reply.code(401).send({ error: 'Unauthorized' });
        }

        const { userId, functionName, parameters, appSessionId, gatewaySessionId } = request.body;
        const rpcMethod = `voice-tool:${functionName}`;

        try {
            const rpcResponse = await invokeUserRpc(userId, rpcMethod, {
                gatewaySessionId,
                appSessionId,
                parameters: parameters || {},
            });

            if (typeof rpcResponse === 'string') {
                return reply.send({ result: rpcResponse });
            }

            if (rpcResponse && typeof rpcResponse.result === 'string') {
                return reply.send({ result: rpcResponse.result });
            }

            return reply.send({ result: JSON.stringify(rpcResponse ?? '') });
        } catch (error) {
            log({ module: 'voice-tool-bridge', level: 'error' }, `RPC tool call failed: ${functionName} for user ${userId}: ${error}`);
            return reply.code(503).send({
                error: 'RPC method not available',
            });
        }
    });
}
