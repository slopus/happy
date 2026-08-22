import { z } from "zod";
import * as crypto from "crypto";
import { VoiceConversationResponseSchema, VoiceUsageResponseSchema, type VoiceConversationResponse } from "@slopus/happy-wire";
import { type Fastify } from "../types";
import { log } from "@/utils/log";
import { resolveVoiceConversationId, type ElevenLabsTokenResponse } from "./voiceToken";

const VOICE_FREE_LIMIT_SECONDS = 1200;  // 20 minutes free tier per 30 days (~$0.76 cost)
const VOICE_HARD_LIMIT_SECONDS = 18000; // 5 hours per paid billing period
const VOICE_MAX_CONVERSATIONS = 100;    // Max conversations trackable in the current quota window
const ELEVEN_LABS_API = "https://api.elevenlabs.io/v1/convai";
const REVENUECAT_API = "https://api.revenuecat.com/v2";
const REVENUECAT_PROJECT_ID = "proj493735ad";
const EXTERNAL_REQUEST_TIMEOUT_MS = 8_000;
const SUBSCRIPTION_CACHE_TTL_MS = 60_000;
const MAX_CACHED_SUBSCRIPTION_INFOS = 10_000;
const MAX_USAGE_PAGES = 10;
// Must be at least the ElevenLabs agent's configured max_duration_seconds.
const DEFAULT_MAX_CONVERSATION_DURATION_SECONDS = VOICE_HARD_LIMIT_SECONDS;
const MAX_CONFIGURED_CONVERSATION_DURATION_SECONDS = 24 * 60 * 60;
const ElevenLabsTokenResponseSchema = z.object({
    token: z.string().min(1),
    conversation_id: z.string().regex(/^conv_[a-zA-Z0-9]+$/).optional(),
});
const ElevenLabsUsageResponseSchema = z.object({
    conversations: z.array(z.object({
        start_time_unix_secs: z.number().int().nonnegative(),
        call_duration_secs: z.number().finite().nonnegative(),
    })),
    has_more: z.boolean().optional(),
    next_cursor: z.string().min(1).nullable().optional(),
});
const RevenueCatEntitlementsResponseSchema = z.object({
    items: z.array(z.object({
        entitlement_id: z.string().min(1),
        expires_at: z.number().int().nonnegative().nullable().optional(),
    })),
    next_page: z.string().min(1).nullable().optional(),
});
const RevenueCatCustomerResponseSchema = z.object({
    active_entitlements: RevenueCatEntitlementsResponseSchema,
});
const RevenueCatSubscriptionsResponseSchema = z.object({
    items: z.array(z.object({
        current_period_starts_at: z.number().int().nonnegative(),
        current_period_ends_at: z.number().int().nonnegative().nullable(),
        gives_access: z.boolean(),
        status: z.string().min(1),
        entitlements: z.object({
            items: z.array(z.object({
                id: z.string().min(1),
            })),
            next_page: z.string().min(1).nullable().optional(),
        }),
    })),
    next_page: z.string().min(1).nullable().optional(),
});

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const signal = AbortSignal.timeout(EXTERNAL_REQUEST_TIMEOUT_MS);
    return fetch(url, {
        ...init,
        // @types/node exposes two structurally different AbortSignal types;
        // runtime has one signal, matching the existing push transport bridge.
        signal: signal as unknown as RequestInit['signal'],
    });
}

function getMaxConversationDurationSeconds(): number {
    const configured = Number(process.env.VOICE_MAX_CONVERSATION_DURATION_SECONDS);
    if (
        Number.isInteger(configured)
        && configured > 0
        && configured <= MAX_CONFIGURED_CONVERSATION_DURATION_SECONDS
    ) {
        return configured;
    }
    return DEFAULT_MAX_CONVERSATION_DURATION_SECONDS;
}

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
 * Get a user's voice usage in seconds since the current quota window began.
 * Queries ElevenLabs directly by user_id (set via participant_name on token mint).
 * ElevenLabs is the source of truth — no local DB needed.
 *
 * Counts only the portion of each call that overlaps the quota window. The
 * bounded lookback catches calls which started before the boundary and ran
 * into it. Conversation count only includes calls that start in the window.
 */
async function getVoiceUsage(
    elevenLabsApiKey: string,
    elevenUserId: string,
    windowStartedAtUnix: number,
): Promise<{ usedSeconds: number; conversationCount: number }> {
    try {
        // Query across all agents — usage is per-user, not per-agent. The
        // lookback is bounded by the configured maximum conversation duration.
        const queryStartedAtUnix = Math.max(
            0,
            windowStartedAtUnix - getMaxConversationDurationSeconds(),
        );
        let usedSeconds = 0;
        let conversationCount = 0;
        let cursor: string | undefined;

        for (let page = 0; page < MAX_USAGE_PAGES; page += 1) {
            const params = new URLSearchParams({
                user_id: elevenUserId,
                call_start_after_unix: String(queryStartedAtUnix),
                page_size: '100',
            });
            if (cursor) params.set('cursor', cursor);
            const res = await fetchWithTimeout(
                `${ELEVEN_LABS_API}/conversations?${params}`,
                { headers: { "xi-api-key": elevenLabsApiKey } }
            );

            if (!res.ok) {
                throw new Error(`ElevenLabs conversations query failed: ${res.status}`);
            }

            const data = ElevenLabsUsageResponseSchema.parse(await res.json());
            for (const c of data.conversations) {
                const conversationEndsAtUnix = c.start_time_unix_secs + c.call_duration_secs;
                const overlapSeconds = Math.max(
                    0,
                    conversationEndsAtUnix - Math.max(c.start_time_unix_secs, windowStartedAtUnix),
                );
                if (overlapSeconds > 0) usedSeconds += overlapSeconds;
                if (c.start_time_unix_secs >= windowStartedAtUnix) conversationCount += 1;
            }

            // We already know token issuance must be denied. Avoid extra pages
            // while keeping the count policy independent of pre-window calls.
            if (conversationCount >= VOICE_MAX_CONVERSATIONS) {
                return { usedSeconds, conversationCount: VOICE_MAX_CONVERSATIONS };
            }
            if (!data.has_more) return { usedSeconds, conversationCount };
            if (!data.next_cursor) {
                throw new Error('ElevenLabs conversations response has_more without next_cursor');
            }
            cursor = data.next_cursor;
        }
        throw new Error(`ElevenLabs conversations exceeded ${MAX_USAGE_PAGES} pages in quota lookback`);
    } catch (error) {
        log({ module: 'voice' }, `ElevenLabs conversations query error: ${error}`);
        throw error;
    }
}

type SubscriptionInfo =
    | { status: 'active'; billingPeriodStartedAtUnix: number; billingPeriodEndsAtUnix: number | null }
    | { status: 'active_non_subscription' }
    | { status: 'inactive' }
    | { status: 'unavailable' };

type CachedSubscriptionInfo = {
    value: Exclude<SubscriptionInfo, { status: 'unavailable' }>;
    expiresAt: number;
};

const subscriptionInfoCache = new Map<string, CachedSubscriptionInfo>();
const subscriptionInfoInFlight = new Map<string, Promise<SubscriptionInfo>>();

function readCachedSubscriptionInfo(userId: string): CachedSubscriptionInfo['value'] | null {
    const cached = subscriptionInfoCache.get(userId);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
        subscriptionInfoCache.delete(userId);
        return null;
    }
    return cached.value;
}

function cacheSubscriptionInfo(userId: string, value: CachedSubscriptionInfo['value']): void {
    if (subscriptionInfoCache.size >= MAX_CACHED_SUBSCRIPTION_INFOS) {
        const oldestKey = subscriptionInfoCache.keys().next().value;
        if (oldestKey) subscriptionInfoCache.delete(oldestKey);
    }
    const expiresAt = value.status === 'active' && value.billingPeriodEndsAtUnix !== null
        ? Math.min(Date.now() + SUBSCRIPTION_CACHE_TTL_MS, value.billingPeriodEndsAtUnix)
        : Date.now() + SUBSCRIPTION_CACHE_TTL_MS;
    if (expiresAt <= Date.now()) return;
    subscriptionInfoCache.set(userId, {
        value,
        expiresAt,
    });
}

async function fetchSubscriptionInfo(userId: string, revenueCatApiKey: string): Promise<SubscriptionInfo> {
    try {
        const headers = { "Authorization": `Bearer ${revenueCatApiKey}` };
        const encodedUserId = encodeURIComponent(userId);
        const customerUrl = `${REVENUECAT_API}/projects/${REVENUECAT_PROJECT_ID}/customers/${encodedUserId}`;
        const customerResponse = await fetchWithTimeout(customerUrl, { method: "GET", headers });
        if (!customerResponse.ok) {
            log(
                { module: 'voice' },
                `RevenueCat customer check failed for ${userId}: ${customerResponse.status}`,
            );
            return { status: 'unavailable' };
        }

        const customer = RevenueCatCustomerResponseSchema.parse(await customerResponse.json());
        const entitlements = customer.active_entitlements;
        if (entitlements.next_page) {
            log({ module: 'voice' }, `RevenueCat active entitlement data was truncated for ${userId}`);
            return { status: 'unavailable' };
        }
        if (entitlements.items.length === 0) {
            return { status: 'inactive' };
        }

        const subscriptionsResponse = await fetchWithTimeout(
            `${customerUrl}/subscriptions?limit=100`,
            { method: "GET", headers },
        );
        if (!subscriptionsResponse.ok) {
            log({ module: 'voice' }, `RevenueCat subscription check failed for ${userId}: ${subscriptionsResponse.status}`);
            return { status: 'unavailable' };
        }
        const subscriptions = RevenueCatSubscriptionsResponseSchema.parse(await subscriptionsResponse.json());
        if (subscriptions.next_page) {
            log({ module: 'voice' }, `RevenueCat subscription data was truncated for ${userId}`);
            return { status: 'unavailable' };
        }

        // A customer can have historical subscriptions in this list. The most
        // recent access-granting period is the quota window that renewed last.
        const activeEntitlementIds = new Set(
            entitlements.items.map((entitlement) => entitlement.entitlement_id),
        );
        const now = Date.now();
        if (subscriptions.items.some((subscription) => (
            subscription.gives_access && subscription.entitlements.next_page
        ))) {
            log({ module: 'voice' }, `RevenueCat subscription entitlements were truncated for ${userId}`);
            return { status: 'unavailable' };
        }
        const activeBillingPeriod = subscriptions.items
            .filter((subscription) => (
                subscription.gives_access
                && subscription.current_period_starts_at <= now
                && (
                    subscription.current_period_ends_at === null
                    || subscription.current_period_ends_at > now
                )
                && subscription.entitlements.items.some(({ id }) => activeEntitlementIds.has(id))
            ))
            .sort((a, b) => b.current_period_starts_at - a.current_period_starts_at)[0];

        if (!activeBillingPeriod) {
            // Non-consumable/lifetime purchases grant active entitlements but do
            // not appear in subscriptions. They receive the paid hard limit in
            // a rolling 30-day window because there is no billing boundary.
            return { status: 'active_non_subscription' };
        }

        return {
            status: 'active',
            billingPeriodStartedAtUnix: Math.floor(activeBillingPeriod.current_period_starts_at / 1000),
            billingPeriodEndsAtUnix: activeBillingPeriod.current_period_ends_at,
        };
    } catch (error) {
        log({ module: 'voice' }, `RevenueCat check error for ${userId}: ${error}`);
        return { status: 'unavailable' };
    }
}

async function getSubscriptionInfo(userId: string): Promise<SubscriptionInfo> {
    const revenueCatApiKey = process.env.REVENUECAT_API_KEY;
    // Self-hosted/dev servers without RevenueCat run the free-tier policy.
    if (!revenueCatApiKey) return { status: 'inactive' };

    const cached = readCachedSubscriptionInfo(userId);
    if (cached) return cached;

    const inFlight = subscriptionInfoInFlight.get(userId);
    if (inFlight) return inFlight;

    const request = fetchSubscriptionInfo(userId, revenueCatApiKey)
        .then((info) => {
            // Do not cache inactive: a completed purchase can be visible on the
            // immediate retry after the client dismisses the paywall.
            if (info.status === 'active' || info.status === 'active_non_subscription') {
                cacheSubscriptionInfo(userId, info);
            }
            return info;
        })
        .finally(() => {
            subscriptionInfoInFlight.delete(userId);
        });

    // Keep attacker-controlled distinct user IDs from growing the dedup map
    // without a bound. In that rare case the request retains no-cache behavior.
    if (subscriptionInfoInFlight.size < MAX_CACHED_SUBSCRIPTION_INFOS) {
        subscriptionInfoInFlight.set(userId, request);
    }
    return request;
}

function getRollingVoiceWindowStartUnix(): number {
    return Math.floor((Date.now() - 30 * 86400 * 1000) / 1000);
}

function isPaidVoiceAccess(subscriptionInfo: SubscriptionInfo): boolean {
    return subscriptionInfo.status === 'active' || subscriptionInfo.status === 'active_non_subscription';
}

function getVoiceWindowStartUnix(subscriptionInfo: SubscriptionInfo): number {
    return subscriptionInfo.status === 'active'
        ? subscriptionInfo.billingPeriodStartedAtUnix
        : getRollingVoiceWindowStartUnix();
}

type VoiceConversationResult =
    | { statusCode: 200; body: VoiceConversationResponse }
    | { statusCode: 503; body: { error: string } };

async function createVoiceConversationResult(
    userId: string,
    agentId: string,
    elevenLabsApiKey: string,
    elevenUserId: string,
): Promise<VoiceConversationResult> {
    const subscriptionInfo = await getSubscriptionInfo(userId);
    const windowStartedAtUnix = getVoiceWindowStartUnix(subscriptionInfo);
    const limitSeconds = isPaidVoiceAccess(subscriptionInfo)
        ? VOICE_HARD_LIMIT_SECONDS
        : VOICE_FREE_LIMIT_SECONDS;

    // Subscriptions reset at RevenueCat's billing-period boundary. Free and
    // lifetime/non-subscription access use a rolling window.
    let usedSeconds: number;
    let conversationCount: number;
    try {
        ({ usedSeconds, conversationCount } = await getVoiceUsage(
            elevenLabsApiKey,
            elevenUserId,
            windowStartedAtUnix,
        ));
    } catch {
        return { statusCode: 503, body: { error: 'Voice usage temporarily unavailable' } };
    }
    log(
        { module: 'voice' },
        `User ${userId}: ${usedSeconds}s used, ${conversationCount} convos, subscription=${subscriptionInfo.status}, window_start=${windowStartedAtUnix}, limit=${limitSeconds}s`,
    );

        // Conversation count cap for the user's current quota window.
    if (conversationCount >= VOICE_MAX_CONVERSATIONS) {
        if (subscriptionInfo.status === 'unavailable') {
            return { statusCode: 503, body: { error: 'Subscription status temporarily unavailable' } };
        }
        return {
            statusCode: 200,
            body: {
                allowed: false as const,
                reason: 'voice_conversation_limit_reached' as const,
                usedSeconds,
                limitSeconds,
                agentId,
            },
        };
    }

    if (isPaidVoiceAccess(subscriptionInfo) && usedSeconds >= VOICE_HARD_LIMIT_SECONDS) {
        return {
            statusCode: 200,
            body: {
                allowed: false as const,
                reason: 'voice_hard_limit_reached' as const,
                usedSeconds,
                limitSeconds: VOICE_HARD_LIMIT_SECONDS,
                agentId,
            },
        };
    }

    if (subscriptionInfo.status === 'inactive' && usedSeconds >= VOICE_FREE_LIMIT_SECONDS) {
        return {
            statusCode: 200,
            body: {
                allowed: false as const,
                reason: 'subscription_required' as const,
                usedSeconds,
                limitSeconds: VOICE_FREE_LIMIT_SECONDS,
                agentId,
            },
        };
    }
    if (subscriptionInfo.status === 'unavailable' && usedSeconds >= VOICE_FREE_LIMIT_SECONDS) {
        return { statusCode: 503, body: { error: 'Subscription status temporarily unavailable' } };
    }

    try {
        const params = new URLSearchParams({
            agent_id: agentId,
            participant_name: elevenUserId,
        });
        const tokenStartedAt = Date.now();
        const tokenRes = await fetchWithTimeout(
            `${ELEVEN_LABS_API}/conversation/token?${params}`,
            { headers: { 'xi-api-key': elevenLabsApiKey } }
        );

        if (!tokenRes.ok) {
            log({ module: 'voice' }, `Failed to get conversation token for user ${userId}: ${tokenRes.status} after ${Date.now() - tokenStartedAt}ms`);
            return { statusCode: 503, body: { error: 'Voice service temporarily unavailable' } };
        }

        const parsedTokenBody = ElevenLabsTokenResponseSchema.safeParse(await tokenRes.json());
        if (!parsedTokenBody.success) {
            log({ module: 'voice' }, `Invalid voice token response for user ${userId}`);
            return { statusCode: 503, body: { error: 'Voice service temporarily unavailable' } };
        }
        const tokenBody = parsedTokenBody.data satisfies ElevenLabsTokenResponse;
        const conversationToken = tokenBody.token;

        // Current ElevenLabs responses include conversation_id directly. Keep
        // the JWT fallback for older deployments instead of relying on it.
        const conversationId = resolveVoiceConversationId(tokenBody);

        if (!conversationId) {
            log({ module: 'voice' }, `No valid conversation_id in token response for user ${userId}`);
            return { statusCode: 503, body: { error: 'Voice service temporarily unavailable' } };
        }

        log({ module: 'voice' }, `Voice token issued for user ${userId}, conv=${conversationId}, latency=${Date.now() - tokenStartedAt}ms`);
        return {
            statusCode: 200,
            body: {
                allowed: true as const,
                conversationToken,
                conversationId,
                agentId,
                elevenUserId,
                usedSeconds,
                limitSeconds,
            },
        };
    } catch (error) {
        log({ module: 'voice' }, `ElevenLabs request error for user ${userId}: ${error}`);
        return { statusCode: 503, body: { error: 'Voice service temporarily unavailable' } };
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
                503: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { agentId } = request.body;

        log({ module: 'voice' }, `Voice token request from user ${userId}`);

        const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
        if (!elevenLabsApiKey) {
            log({ module: 'voice' }, 'Voice service unavailable: ELEVENLABS_API_KEY not configured');
            return reply.code(500).send({ error: 'Voice service unavailable' });
        }
        if (!process.env.HANDY_MASTER_SECRET) {
            log({ module: 'voice' }, 'Voice service unavailable: HANDY_MASTER_SECRET not configured');
            return reply.code(500).send({ error: 'Voice service unavailable' });
        }

        const elevenUserId = deriveElevenUserId(userId);
        const result = await createVoiceConversationResult(userId, agentId, elevenLabsApiKey, elevenUserId);
        return reply.code(result.statusCode).send(result.body);
    });

    /**
     * Returns voice usage for the authenticated user's current quota window.
     * Queries ElevenLabs directly — no local DB needed.
     */
    app.get('/v1/voice/usage', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: VoiceUsageResponseSchema,
                500: z.object({ error: z.string() }),
                503: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;

        const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
        if (!elevenLabsApiKey) {
            log({ module: 'voice' }, 'Voice service unavailable: ELEVENLABS_API_KEY not configured');
            return reply.code(500).send({ error: 'Voice service unavailable' });
        }
        if (!process.env.HANDY_MASTER_SECRET) {
            log({ module: 'voice' }, 'Voice service unavailable: HANDY_MASTER_SECRET not configured');
            return reply.code(500).send({ error: 'Voice service unavailable' });
        }

        const elevenUserId = deriveElevenUserId(userId);

        try {
            const subscriptionInfo = await getSubscriptionInfo(userId);
            if (subscriptionInfo.status === 'unavailable') {
                return reply.code(503).send({ error: 'Subscription status temporarily unavailable' });
            }
            const windowStartedAtUnix = getVoiceWindowStartUnix(subscriptionInfo);
            const { usedSeconds, conversationCount } = await getVoiceUsage(
                elevenLabsApiKey,
                elevenUserId,
                windowStartedAtUnix,
            );
            return reply.send({
                usedSeconds,
                limitSeconds: isPaidVoiceAccess(subscriptionInfo) ? VOICE_HARD_LIMIT_SECONDS : VOICE_FREE_LIMIT_SECONDS,
                conversationCount,
                conversationLimit: VOICE_MAX_CONVERSATIONS,
                elevenUserId,
            });
        } catch (error) {
            log({ module: 'voice' }, `Failed to get voice usage for user ${userId}: ${error}`);
            return reply.code(503).send({ error: 'Voice usage temporarily unavailable' });
        }
    });
}
