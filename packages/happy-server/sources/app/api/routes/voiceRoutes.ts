import { z } from "zod";
import * as crypto from "crypto";
import { type Fastify } from "../types";

const VoiceTokenResponseSchema = z.discriminatedUnion("allowed", [
    z.object({
        allowed: z.literal(true),
        token: z.string(),
        agentId: z.string(),
        elevenUserId: z.string(),
        usedSeconds: z.number(),
        limitSeconds: z.number(),
    }),
    z.object({
        allowed: z.literal(false),
        reason: z.literal("voice_limit_reached"),
        usedSeconds: z.number(),
        limitSeconds: z.number(),
        agentId: z.string(),
    }),
]);
import { log } from "@/utils/log";

const VOICE_FREE_LIMIT_SECONDS = 3600;

/**
 * Derives a stable pseudonymous ElevenLabs user ID from the Happy user ID.
 * Uses HMAC-SHA256 with the server master secret so the mapping is consistent
 * across sessions but the raw Happy ID is never exposed to ElevenLabs.
 */
function deriveElevenUserId(happyUserId: string): string {
    const hmac = crypto.createHmac("sha256", process.env.HANDY_MASTER_SECRET!);
    hmac.update(happyUserId);
    const digest = hmac.digest();
    const base64url = digest
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    return `u_${base64url}`;
}

/**
 * Fetches the first page of ElevenLabs conversations for a user and returns
 * the sum of call_duration_secs across all returned conversations.
 */
async function getUsedVoiceSeconds(
    elevenLabsApiKey: string,
    elevenUserId: string
): Promise<number> {
    const url = new URL("https://api.elevenlabs.io/v1/convai/conversations");
    url.searchParams.set("user_id", elevenUserId);
    url.searchParams.set("page_size", "100");

    const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
            "xi-api-key": elevenLabsApiKey,
            "Accept": "application/json",
        },
    });

    if (!response.ok) {
        throw new Error(
            `ElevenLabs conversation history request failed: ${response.status}`
        );
    }

    const data = (await response.json()) as {
        conversations?: Array<{ call_duration_secs?: number }>;
    };

    let totalSeconds = 0;
    for (const conv of data.conversations ?? []) {
        totalSeconds += conv.call_duration_secs ?? 0;
    }
    return totalSeconds;
}

/**
 * Checks whether the user has an active "pro" entitlement via RevenueCat
 * using the server-side API key (not the client public key).
 */
async function hasActiveSubscription(userId: string): Promise<boolean> {
    const revenueCatApiKey = process.env.REVENUECAT_API_KEY;
    if (!revenueCatApiKey) {
        log({ module: "voice" }, "REVENUECAT_API_KEY not configured, treating as no subscription");
        return false;
    }

    try {
        const response = await fetch(
            `https://api.revenuecat.com/v1/subscribers/${userId}`,
            {
                method: "GET",
                headers: {
                    "Authorization": `Bearer ${revenueCatApiKey}`,
                    "Content-Type": "application/json",
                },
            }
        );

        if (!response.ok) {
            log({ module: "voice" }, `RevenueCat check failed for user ${userId}: ${response.status}`);
            return false;
        }

        const data = (await response.json()) as any;
        return !!data.subscriber?.entitlements?.active?.pro;
    } catch (error) {
        log({ module: "voice" }, `RevenueCat check error for user ${userId}: ${error}`);
        return false;
    }
}

export function voiceRoutes(app: Fastify) {
    app.post('/v1/voice/token', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                agentId: z.string(),
            }),
            response: {
                200: VoiceTokenResponseSchema,
                500: z.object({
                    error: z.string(),
                }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId; // CUID from JWT
        const { agentId } = request.body;

        log({ module: 'voice' }, `Voice token request from user ${userId}`);

        const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
        if (!elevenLabsApiKey) {
            log({ module: 'voice' }, 'Missing ELEVENLABS_API_KEY');
            return reply.code(500).send({ error: 'Voice service not configured' });
        }

        const elevenUserId = deriveElevenUserId(userId);

        // Check usage against ElevenLabs conversation history
        let usedSeconds: number;
        try {
            usedSeconds = await getUsedVoiceSeconds(elevenLabsApiKey, elevenUserId);
        } catch (error) {
            log({ module: 'voice' }, `Failed to check voice usage for user ${userId}: ${error}`);
            return reply.code(500).send({ error: 'Failed to check voice usage' });
        }

        log({ module: 'voice' }, `User ${userId} has used ${usedSeconds}s of ${VOICE_FREE_LIMIT_SECONDS}s`);

        // If over the free limit, check subscription
        if (usedSeconds >= VOICE_FREE_LIMIT_SECONDS) {
            const subscribed = await hasActiveSubscription(userId);
            if (!subscribed) {
                return reply.send({
                    allowed: false as const,
                    reason: 'voice_limit_reached' as const,
                    usedSeconds,
                    limitSeconds: VOICE_FREE_LIMIT_SECONDS,
                    agentId,
                });
            }
        }

        // Mint an ElevenLabs conversation token
        try {
            const tokenResponse = await fetch(
                `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${agentId}`,
                {
                    method: 'GET',
                    headers: {
                        'xi-api-key': elevenLabsApiKey,
                        'Accept': 'application/json',
                    },
                }
            );

            if (!tokenResponse.ok) {
                log({ module: 'voice' }, `Failed to get ElevenLabs token for user ${userId}: ${tokenResponse.status}`);
                return reply.code(500).send({ error: 'Failed to get voice token' });
            }

            const tokenData = (await tokenResponse.json()) as { token: string };

            log({ module: 'voice' }, `Voice token issued for user ${userId}`);
            return reply.send({
                allowed: true as const,
                token: tokenData.token,
                agentId,
                elevenUserId,
                usedSeconds,
                limitSeconds: VOICE_FREE_LIMIT_SECONDS,
            });
        } catch (error) {
            log({ module: 'voice' }, `ElevenLabs token request error for user ${userId}: ${error}`);
            return reply.code(500).send({ error: 'Failed to get voice token' });
        }
    });
}
