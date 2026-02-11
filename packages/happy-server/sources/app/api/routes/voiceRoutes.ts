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
    app.post('/v1/voice/token', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                agentId: z.string(),
                revenueCatPublicKey: z.string().optional()
            }),
            response: {
                200: z.object({
                    allowed: z.boolean(),
                    token: z.string().optional(),
                    agentId: z.string().optional()
                }),
                400: z.object({
                    allowed: z.boolean(),
                    error: z.string()
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId; // CUID from JWT
        const { agentId, revenueCatPublicKey } = request.body;

        log({ module: 'voice' }, `Voice token request from user ${userId}`);

        const isDevelopment = process.env.NODE_ENV === 'development' || process.env.ENV === 'dev';

        // Production requires RevenueCat key
        if (!isDevelopment && !revenueCatPublicKey) {
            log({ module: 'voice' }, 'Production environment requires RevenueCat public key');
            return reply.code(400).send({ 
                allowed: false,
                error: 'RevenueCat public key required'
            });
        }

        // Check subscription in production
        if (!isDevelopment && revenueCatPublicKey) {
            const response = await fetch(
                `https://api.revenuecat.com/v1/subscribers/${userId}`,
                {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${revenueCatPublicKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (!response.ok) {
                log({ module: 'voice' }, `RevenueCat check failed for user ${userId}: ${response.status}`);
                return reply.send({ 
                    allowed: false,
                    agentId
                });
            }

            const data = await response.json() as any;
            const proEntitlement = data.subscriber?.entitlements?.active?.pro;
            
            if (!proEntitlement) {
                log({ module: 'voice' }, `User ${userId} does not have active subscription`);
                return reply.send({ 
                    allowed: false,
                    agentId
                });
            }
        }

        // Check if 11Labs API key is configured
        const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
        if (!elevenLabsApiKey) {
            log({ module: 'voice' }, 'Missing 11Labs API key');
            return reply.code(400).send({ allowed: false, error: 'Missing 11Labs API key on the server' });
        }

        // Get 11Labs conversation token
        const response = await fetch(
            `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${agentId}`,
            {
                method: 'GET',
                headers: {
                    'xi-api-key': elevenLabsApiKey,
                    'Accept': 'application/json'
                }
            }
        );
        
        if (!response.ok) {
            log({ module: 'voice' }, `Failed to get 11Labs token for user ${userId}`);
            return reply.code(400).send({ 
                allowed: false,
                error: `Failed to get 11Labs token for user ${userId}`
            });
        }

        const data = await response.json() as any;
        const token = data.token;

        log({ module: 'voice' }, `Voice token issued for user ${userId}`);
        return reply.send({
            allowed: true,
            token,
            agentId
        });
    });

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
