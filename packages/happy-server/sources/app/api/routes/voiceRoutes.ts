import { z } from "zod";
import * as crypto from "crypto";
import { VoiceConversationResponseSchema, VoiceUsageResponseSchema } from "@slopus/happy-wire";
import { type Fastify } from "../types";
import { log } from "@/utils/log";

const VOICE_FREE_LIMIT_SECONDS = 1200;  // 20 minutes free tier per 30 days (~$0.76 cost)
const VOICE_HARD_LIMIT_SECONDS = 18000; // 5 hours absolute cap per 30 days (even with subscription)
const VOICE_USAGE_PAGE_SIZE = 100;     // ElevenLabs maximum page size, not a conversation quota
const ELEVEN_LABS_API = "https://api.elevenlabs.io/v1/convai";

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
 * Get a user's voice usage in seconds over the last 30 days.
 * Queries ElevenLabs directly by user_id (set via participant_name on token mint).
 * ElevenLabs is the source of truth — no local DB needed.
 *
 * Returns { usedSeconds, conversationCount }, stopping once the hard duration
 * quota is reached. Above that quota, these are lower bounds on monthly usage.
 */
async function getVoiceUsage(
    elevenLabsApiKey: string,
    elevenUserId: string,
): Promise<{ usedSeconds: number; conversationCount: number }> {
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;

    let usedSeconds = 0;
    let conversationCount = 0;
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    const signal = AbortSignal.timeout(15_000);

    do {
        // Query across all agents — usage is per-user, not per-agent.
        const query = new URLSearchParams({
            user_id: elevenUserId,
            call_start_after_unix: String(thirtyDaysAgo),
            page_size: String(VOICE_USAGE_PAGE_SIZE),
        });
        if (cursor) query.set("cursor", cursor);
        const res = await fetch(`${ELEVEN_LABS_API}/conversations?${query}`, {
            headers: { "xi-api-key": elevenLabsApiKey },
            // Bridge the conflicting Node 20/undici AbortSignal declarations,
            // as in pushSend; at runtime these refer to the same native signal.
            signal: signal as unknown as RequestInit['signal'],
        });
        if (!res.ok) {
            throw new Error(`ElevenLabs conversations query failed: ${res.status}`);
        }

        const data = (await res.json()) as {
            conversations?: Array<{ call_duration_secs?: number | null }>;
            has_more?: boolean;
            next_cursor?: string | null;
        };
        if (!Array.isArray(data.conversations) || typeof data.has_more !== "boolean") {
            throw new Error("Invalid ElevenLabs conversation history");
        }
        for (const conversation of data.conversations) {
            const duration = conversation.call_duration_secs ?? 0;
            if (!Number.isFinite(duration) || duration < 0) {
                throw new Error("Invalid ElevenLabs conversation duration");
            }
            usedSeconds += duration;
        }
        conversationCount += data.conversations.length;

        // Once the actual duration quota is reached, further history cannot allow voice.
        if (usedSeconds >= VOICE_HARD_LIMIT_SECONDS || !data.has_more) break;
        if (!data.next_cursor || typeof data.next_cursor !== "string" || seenCursors.has(data.next_cursor)) {
            throw new Error("Invalid ElevenLabs conversation history cursor");
        }
        seenCursors.add(data.next_cursor);
        cursor = data.next_cursor;
    } while (cursor);

    return { usedSeconds, conversationCount };
}

async function hasActiveSubscription(userId: string): Promise<boolean> {
    const revenueCatApiKey = process.env.REVENUECAT_API_KEY;
    if (!revenueCatApiKey) return false;

    try {
        const response = await fetch(
            `https://api.revenuecat.com/v2/projects/proj493735ad/customers/${userId}/active_entitlements`,
            {
                method: "GET",
                headers: {
                    "Authorization": `Bearer ${revenueCatApiKey}`,
                },
            }
        );
        if (!response.ok) {
            log({ module: 'voice' }, `RevenueCat check failed for ${userId}: ${response.status}`);
            return false;
        }
        const data = (await response.json()) as { items?: Array<{ entitlement_id: string }> };
        return (data.items?.length ?? 0) > 0;
    } catch {
        return false;
    }
}

export function voiceRoutes(app: Fastify) {
    app.post('/v1/voice/conversations', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                agentId: z.string(),
            }),
            response: {
                200: VoiceConversationResponseSchema,
                500: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { agentId } = request.body;

        log({ module: 'voice' }, `Voice token request from user ${userId}`);

        const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
        if (!elevenLabsApiKey) {
            return reply.code(500).send({ error: 'ELEVENLABS_API_KEY not configured' });
        }
        const elevenUserId = deriveElevenUserId(userId);

        // Check usage from ElevenLabs directly
        let usage: Awaited<ReturnType<typeof getVoiceUsage>>;
        try {
            usage = await getVoiceUsage(elevenLabsApiKey, elevenUserId);
        } catch (error) {
            log({ module: 'voice' }, `Failed to get voice usage for user ${userId}: ${error}`);
            return reply.code(500).send({ error: 'Failed to get voice usage' });
        }
        const { usedSeconds, conversationCount } = usage;
        log({ module: 'voice' }, `User ${userId}: ${usedSeconds}s used, ${conversationCount} convos (free=${VOICE_FREE_LIMIT_SECONDS}s, hard=${VOICE_HARD_LIMIT_SECONDS}s)`);

        // Hard cap — 5 hours, no exceptions
        if (usedSeconds >= VOICE_HARD_LIMIT_SECONDS) {
            return reply.send({
                allowed: false as const,
                reason: 'voice_hard_limit_reached' as const,
                usedSeconds,
                limitSeconds: VOICE_HARD_LIMIT_SECONDS,
                agentId,
            });
        }

        // Free tier — 20 minutes, then need subscription
        if (usedSeconds >= VOICE_FREE_LIMIT_SECONDS) {
            const subscribed = await hasActiveSubscription(userId);
            log({ module: 'voice' }, `User ${userId}: subscription check = ${subscribed}`);
            if (!subscribed) {
                return reply.send({
                    allowed: false as const,
                    reason: 'subscription_required' as const,
                    usedSeconds,
                    limitSeconds: VOICE_FREE_LIMIT_SECONDS,
                    agentId,
                });
            }
        }

        // Get conversation token (JWT for WebRTC) with user identity
        try {
            const tokenRes = await fetch(
                `${ELEVEN_LABS_API}/conversation/token?agent_id=${agentId}&participant_name=${elevenUserId}`,
                { headers: { 'xi-api-key': elevenLabsApiKey } }
            );

            if (!tokenRes.ok) {
                log({ module: 'voice' }, `Failed to get conversation token for user ${userId}: ${tokenRes.status}`);
                return reply.code(500).send({ error: 'Failed to get voice credentials' });
            }

            const { token: conversationToken } = (await tokenRes.json()) as { token: string };

            // Extract conversation_id from JWT payload (LiveKit room name contains it)
            const jwtPayload = JSON.parse(Buffer.from(conversationToken.split('.')[1], 'base64').toString());
            const conversationId = (jwtPayload.video?.room || '').match(/(conv_[a-zA-Z0-9]+)/)?.[0];

            if (!conversationId) {
                log({ module: 'voice' }, `No conversation_id in JWT for user ${userId}`);
                return reply.code(500).send({ error: 'Failed to get conversation ID' });
            }

            log({ module: 'voice' }, `Voice token issued for user ${userId}, conv=${conversationId}`);
            return reply.send({
                allowed: true as const,
                conversationToken,
                conversationId,
                agentId,
                elevenUserId,
                usedSeconds,
                limitSeconds: usedSeconds >= VOICE_FREE_LIMIT_SECONDS ? VOICE_HARD_LIMIT_SECONDS : VOICE_FREE_LIMIT_SECONDS,
            });
        } catch (error) {
            log({ module: 'voice' }, `ElevenLabs request error for user ${userId}: ${error}`);
            return reply.code(500).send({ error: 'Failed to get voice credentials' });
        }
    });

    /**
     * Returns voice usage for the authenticated user over the last 30 days.
     * Queries ElevenLabs directly — no local DB needed.
     */
    app.get('/v1/voice/usage', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: VoiceUsageResponseSchema,
                500: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;

        const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
        if (!elevenLabsApiKey) {
            return reply.code(500).send({ error: 'ELEVENLABS_API_KEY not configured' });
        }

        const elevenUserId = deriveElevenUserId(userId);

        try {
            const [{ usedSeconds, conversationCount }, subscribed] = await Promise.all([
                getVoiceUsage(elevenLabsApiKey, elevenUserId),
                hasActiveSubscription(userId),
            ]);
            return reply.send({
                usedSeconds,
                limitSeconds: subscribed ? VOICE_HARD_LIMIT_SECONDS : VOICE_FREE_LIMIT_SECONDS,
                conversationCount,
                // Legacy display field required by shipped clients; page size no longer gates voice.
                conversationLimit: VOICE_USAGE_PAGE_SIZE,
                elevenUserId,
            });
        } catch (error) {
            log({ module: 'voice' }, `Failed to get voice usage for user ${userId}: ${error}`);
            return reply.code(500).send({ error: 'Failed to get voice usage' });
        }
    });
}
