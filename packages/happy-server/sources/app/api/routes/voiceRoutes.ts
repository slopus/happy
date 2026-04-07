import { z } from "zod";
import * as crypto from "crypto";
import { VoiceConversationResponseSchema, VoiceUsageResponseSchema } from "@slopus/happy-wire";
import { type Fastify } from "../types";
import { log } from "@/utils/log";
import { db } from "@/storage/db";

const VOICE_FREE_LIMIT_SECONDS = 3600;  // 1 hour free tier per 30 days
const VOICE_HARD_LIMIT_SECONDS = 18000; // 5 hours absolute cap per 30 days (even with subscription)
const ELEVEN_LABS_API = "https://api.elevenlabs.io/v1/convai";

// Only the fields we actually read from ElevenLabs API responses.
// Full schema: https://elevenlabs.io/docs/api-reference/conversations/get
const ElevenLabsConversationSchema = z.object({
    status: z.string(),
    metadata: z.object({
        call_duration_secs: z.number(),
    }).passthrough(),
}).passthrough();

const TERMINAL_STATUSES = new Set(["done", "failed"]);

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
 * Queries our DB for conversation records, then lazily fetches
 * durations from ElevenLabs for any that haven't been filled in.
 *
 * NOTE: Pre-deploy conversations are not in the DB and won't be counted.
 * This is acceptable — usage naturally rolls off over 30 days.
 */
async function getUsedVoiceSeconds(
    elevenLabsApiKey: string,
    accountId: string
): Promise<number> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000);

    const convos = await db.voiceConversation.findMany({
        where: { accountId, createdAt: { gte: thirtyDaysAgo } },
        orderBy: { createdAt: "desc" },
    });

    if (convos.length === 0) return 0;

    const transientDurations = new Map<string, number>();

    // Backfill durations for conversations that don't have them yet
    const needsDuration = convos.filter(c => c.durationSecs === null);
    if (needsDuration.length > 0) {
        await Promise.allSettled(
            needsDuration.map(async (c) => {
                try {
                    const res = await fetch(`${ELEVEN_LABS_API}/conversations/${c.elevenLabsConversationId}`, {
                        headers: { "xi-api-key": elevenLabsApiKey },
                    });
                    if (!res.ok) return;
                    const data = ElevenLabsConversationSchema.parse(await res.json());
                    const dur = data.metadata.call_duration_secs;

                    if (TERMINAL_STATUSES.has(data.status)) {
                        await db.voiceConversation.update({
                            where: { id: c.id },
                            data: { durationSecs: dur },
                        });
                        c.durationSecs = dur;
                        return;
                    }

                    // Active conversations still count against the current request,
                    // but we do not persist them until ElevenLabs reports a terminal status.
                    transientDurations.set(c.id, dur);
                } catch { /* best effort */ }
            })
        );
    }

    let total = 0;
    for (const c of convos) {
        total += c.durationSecs ?? transientDurations.get(c.id) ?? 0;
    }
    return total;
}

async function hasActiveSubscription(userId: string): Promise<boolean> {
    const revenueCatApiKey = process.env.REVENUECAT_API_KEY;
    if (!revenueCatApiKey) return false;

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
        if (!response.ok) return false;
        const data = (await response.json()) as any;
        return !!data.subscriber?.entitlements?.active?.pro;
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
        if (!process.env.REVENUECAT_API_KEY) {
            return reply.code(500).send({ error: 'REVENUECAT_API_KEY not configured' });
        }

        // Check usage from our DB
        const usedSeconds = await getUsedVoiceSeconds(elevenLabsApiKey, userId);
        log({ module: 'voice' }, `User ${userId}: ${usedSeconds}s used (free=${VOICE_FREE_LIMIT_SECONDS}s, hard=${VOICE_HARD_LIMIT_SECONDS}s)`);

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

        // Free tier — 1 hour, then need subscription
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

        // Get signed URL with a known conversation_id
        try {
            const signedUrlRes = await fetch(
                `${ELEVEN_LABS_API}/conversation/get-signed-url?agent_id=${agentId}&include_conversation_id=true`,
                { headers: { 'xi-api-key': elevenLabsApiKey } }
            );

            if (!signedUrlRes.ok) {
                log({ module: 'voice' }, `Failed to get signed URL for user ${userId}: ${signedUrlRes.status}`);
                return reply.code(500).send({ error: 'Failed to get voice credentials' });
            }

            const signedUrlData = (await signedUrlRes.json()) as { signed_url: string; conversation_id?: string };
            const signedUrl = signedUrlData.signed_url;
            const elevenLabsConversationId = signedUrlData.conversation_id
                ?? new URL(signedUrl).searchParams.get("conversation_id");

            if (!elevenLabsConversationId) {
                log({ module: 'voice' }, `No conversation_id in signed URL for user ${userId}`);
                return reply.code(500).send({ error: 'Failed to get conversation ID' });
            }

            // Store the mapping: conversation_id → user
            await db.voiceConversation.create({
                data: {
                    accountId: userId,
                    elevenLabsConversationId: elevenLabsConversationId,
                },
            });

            const elevenUserId = deriveElevenUserId(userId);

            log({ module: 'voice' }, `Voice signed URL issued for user ${userId}, conv=${elevenLabsConversationId}`);
            return reply.send({
                allowed: true as const,
                signedUrl,
                conversationId: elevenLabsConversationId,
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
            const [usedSeconds, subscribed] = await Promise.all([
                getUsedVoiceSeconds(elevenLabsApiKey, userId),
                hasActiveSubscription(userId),
            ]);
            return reply.send({
                usedSeconds,
                limitSeconds: subscribed ? VOICE_HARD_LIMIT_SECONDS : VOICE_FREE_LIMIT_SECONDS,
                elevenUserId,
            });
        } catch (error) {
            log({ module: 'voice' }, `Failed to get voice usage for user ${userId}: ${error}`);
            return reply.code(500).send({ error: 'Failed to get voice usage' });
        }
    });
}
