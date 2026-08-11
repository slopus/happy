import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Fastify } from '../types';
import { voiceRoutes } from './voiceRoutes';

const USER_ID = 'voice-test-user';
const AGENT_ID = 'agent_test123';
let nextTestUserId = 0;

async function buildApp(userId: string): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => {
        request.userId = userId;
    });
    voiceRoutes(typed);
    await typed.ready();
    return typed;
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function activeEntitlementsResponse() {
    return jsonResponse({
        active_entitlements: { items: [{ entitlement_id: 'pro', expires_at: Date.now() + 86400_000 }] },
    });
}

function isCustomerRequest(url: string): boolean {
    return url.includes('/customers/') && !url.includes('/subscriptions');
}

function subscriptionsResponse(periodStartedAt: number) {
    return jsonResponse({
        items: [{
            current_period_starts_at: periodStartedAt,
            current_period_ends_at: periodStartedAt + 30 * 86400_000,
            gives_access: true,
            status: 'active',
            entitlements: { items: [{ id: 'pro' }] },
        }],
    });
}

describe('voice routes', () => {
    let app: Fastify;
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalElevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
    const originalHandyMasterSecret = process.env.HANDY_MASTER_SECRET;
    const originalRevenueCatApiKey = process.env.REVENUECAT_API_KEY;

    beforeEach(async () => {
        process.env.ELEVENLABS_API_KEY = 'eleven-test-key';
        process.env.HANDY_MASTER_SECRET = 'handy-test-secret';
        delete process.env.REVENUECAT_API_KEY;
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        app = await buildApp(`${USER_ID}-${nextTestUserId++}`);
    });

    afterEach(async () => {
        await app.close();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
        if (originalElevenLabsApiKey === undefined) delete process.env.ELEVENLABS_API_KEY;
        else process.env.ELEVENLABS_API_KEY = originalElevenLabsApiKey;
        if (originalHandyMasterSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
        else process.env.HANDY_MASTER_SECRET = originalHandyMasterSecret;
        if (originalRevenueCatApiKey === undefined) delete process.env.REVENUECAT_API_KEY;
        else process.env.REVENUECAT_API_KEY = originalRevenueCatApiKey;
    });

    it('uses the documented 30-day Unix filter and accepts the direct conversation ID', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse({ conversations: [] }))
            .mockResolvedValueOnce(jsonResponse({
                token: 'voice-jwt',
                conversation_id: 'conv_direct123',
            }));

        const response = await app.inject({
            method: 'POST',
            url: '/v1/voice/conversations',
            headers: { authorization: 'Bearer test' },
            payload: { agentId: AGENT_ID },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            allowed: true,
            conversationId: 'conv_direct123',
            conversationToken: 'voice-jwt',
        });

        const usageUrl = new URL(fetchMock.mock.calls[0][0] as string);
        const afterUnix = usageUrl.searchParams.get('call_start_after_unix');
        expect(afterUnix).toMatch(/^\d+$/);
        expect(usageUrl.searchParams.has('created_after')).toBe(false);
        expect(Number(afterUnix)).toBeGreaterThan(Math.floor(Date.now() / 1000) - 31 * 86400);
    });

    it('uses one RevenueCat customer request for inactive users without a subscriptions lookup', async () => {
        process.env.REVENUECAT_API_KEY = 'revenuecat-test-key';
        fetchMock.mockImplementation((url: string) => {
            if (isCustomerRequest(url)) {
                return Promise.resolve(jsonResponse({ active_entitlements: { items: [] } }));
            }
            if (url.includes('/conversations?')) {
                return Promise.resolve(jsonResponse({ conversations: [] }));
            }
            if (url.includes('/conversation/token?')) {
                return Promise.resolve(jsonResponse({
                    token: 'cached-subscription-token',
                    conversation_id: 'conv_cached123',
                }));
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const makeRequest = () => app.inject({
            method: 'POST',
            url: '/v1/voice/conversations',
            headers: { authorization: 'Bearer test' },
            payload: { agentId: AGENT_ID },
        });
        expect((await makeRequest()).statusCode).toBe(200);

        expect(fetchMock.mock.calls.filter(([url]) => isCustomerRequest(String(url)))).toHaveLength(1);
        expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/subscriptions'))).toHaveLength(0);
    });

    it('caches an active subscription across repeated token requests', async () => {
        process.env.REVENUECAT_API_KEY = 'revenuecat-test-key';
        const periodStartedAt = Date.now() - 86400_000;
        fetchMock.mockImplementation((url: string) => {
            if (isCustomerRequest(url)) return Promise.resolve(activeEntitlementsResponse());
            if (url.includes('/subscriptions')) return Promise.resolve(subscriptionsResponse(periodStartedAt));
            if (url.includes('/conversations?')) return Promise.resolve(jsonResponse({ conversations: [] }));
            if (url.includes('/conversation/token?')) {
                return Promise.resolve(jsonResponse({
                    token: 'cached-active-token',
                    conversation_id: 'conv_cachedactive123',
                }));
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const makeRequest = () => app.inject({
            method: 'POST',
            url: '/v1/voice/conversations',
            headers: { authorization: 'Bearer test' },
            payload: { agentId: AGENT_ID },
        });
        expect((await makeRequest()).statusCode).toBe(200);
        expect((await makeRequest()).statusCode).toBe(200);

        expect(fetchMock.mock.calls.filter(([url]) => isCustomerRequest(String(url)))).toHaveLength(1);
        expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/subscriptions'))).toHaveLength(1);
    });

    it('expires active subscription cache at the RevenueCat renewal boundary', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-11T12:00:00.000Z'));
        try {
            process.env.REVENUECAT_API_KEY = 'revenuecat-test-key';
            const firstPeriodStartedAt = Date.now() - 30 * 86400_000;
            const firstPeriodEndsAt = Date.now() + 1_000;
            let subscriptionRequests = 0;
            fetchMock.mockImplementation((url: string) => {
                if (isCustomerRequest(url)) return Promise.resolve(activeEntitlementsResponse());
                if (url.includes('/subscriptions')) {
                    subscriptionRequests += 1;
                    const startsAt = subscriptionRequests === 1 ? firstPeriodStartedAt : firstPeriodEndsAt;
                    const endsAt = subscriptionRequests === 1
                        ? firstPeriodEndsAt
                        : startsAt + 30 * 86400_000;
                    return Promise.resolve(jsonResponse({
                        items: [{
                            current_period_starts_at: startsAt,
                            current_period_ends_at: endsAt,
                            gives_access: true,
                            status: 'active',
                            entitlements: { items: [{ id: 'pro' }] },
                        }],
                    }));
                }
                if (url.includes('/conversations?')) return Promise.resolve(jsonResponse({ conversations: [] }));
                throw new Error(`Unexpected fetch: ${url}`);
            });

            const getUsage = () => app.inject({
                method: 'GET',
                url: '/v1/voice/usage',
                headers: { authorization: 'Bearer test' },
            });
            expect((await getUsage()).statusCode).toBe(200);
            vi.advanceTimersByTime(1_000);
            expect((await getUsage()).statusCode).toBe(200);

            expect(subscriptionRequests).toBe(2);
            const usageCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/conversations?'));
            expect(new URL(usageCalls[1][0] as string).searchParams.get('call_start_after_unix'))
                .toBe(String(Math.floor(firstPeriodEndsAt / 1000) - 18_000));
        } finally {
            vi.useRealTimers();
        }
    });

    it('refreshes inactive access on the immediate post-purchase retry', async () => {
        process.env.REVENUECAT_API_KEY = 'revenuecat-test-key';
        const periodStartedAt = Date.now() - 60_000;
        let customerRequests = 0;
        fetchMock.mockImplementation((url: string) => {
            if (isCustomerRequest(url)) {
                customerRequests += 1;
                return Promise.resolve(customerRequests === 1
                    ? jsonResponse({ active_entitlements: { items: [] } })
                    : activeEntitlementsResponse());
            }
            if (url.includes('/subscriptions')) return Promise.resolve(subscriptionsResponse(periodStartedAt));
            if (url.includes('/conversations?')) return Promise.resolve(jsonResponse({ conversations: [] }));
            if (url.includes('/conversation/token?')) {
                return Promise.resolve(jsonResponse({
                    token: 'post-purchase-token',
                    conversation_id: 'conv_postpurchase123',
                }));
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const makeRequest = () => app.inject({
            method: 'POST',
            url: '/v1/voice/conversations',
            headers: { authorization: 'Bearer test' },
            payload: { agentId: AGENT_ID },
        });
        expect((await makeRequest()).json()).toMatchObject({ limitSeconds: 1200 });
        expect((await makeRequest()).json()).toMatchObject({ limitSeconds: 18_000 });
        expect(customerRequests).toBe(2);
    });

    it('charges only the post-boundary portion of a prior-period call and paginates past it', async () => {
        process.env.REVENUECAT_API_KEY = 'revenuecat-test-key';
        const periodStartedAt = Date.now() - 60_000;
        const windowStartedAtUnix = Math.floor(periodStartedAt / 1000);
        fetchMock.mockImplementation((url: string) => {
            if (isCustomerRequest(url)) return Promise.resolve(activeEntitlementsResponse());
            if (url.includes('/subscriptions')) return Promise.resolve(subscriptionsResponse(periodStartedAt));
            if (url.includes('/conversations?')) {
                const query = new URL(url).searchParams;
                if (query.get('cursor') === 'next-page') {
                    return Promise.resolve(jsonResponse({
                        conversations: [{
                            start_time_unix_secs: windowStartedAtUnix + 5,
                            call_duration_secs: 20,
                        }],
                    }));
                }
                return Promise.resolve(jsonResponse({
                    conversations: [{
                        start_time_unix_secs: windowStartedAtUnix - 120,
                        call_duration_secs: 180,
                    }],
                    has_more: true,
                    next_cursor: 'next-page',
                }));
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const response = await app.inject({
            method: 'GET',
            url: '/v1/voice/usage',
            headers: { authorization: 'Bearer test' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            usedSeconds: 80,
            conversationCount: 1,
        });
        const usageCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/conversations?'));
        expect(usageCalls).toHaveLength(2);
        expect(new URL(usageCalls[0][0] as string).searchParams.get('call_start_after_unix'))
            .toBe(String(windowStartedAtUnix - 18_000));
        expect(new URL(usageCalls[1][0] as string).searchParams.get('cursor')).toBe('next-page');
    });

    it('fails closed and does not mint a token when usage is unavailable', async () => {
        fetchMock.mockRejectedValueOnce(new Error('usage timeout'));

        const response = await app.inject({
            method: 'POST',
            url: '/v1/voice/conversations',
            headers: { authorization: 'Bearer test' },
            payload: { agentId: AGENT_ID },
        });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ error: 'Voice usage temporarily unavailable' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('fails closed when ElevenLabs returns an incomplete usage payload', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({}));

        const response = await app.inject({
            method: 'POST',
            url: '/v1/voice/conversations',
            headers: { authorization: 'Bearer test' },
            payload: { agentId: AGENT_ID },
        });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ error: 'Voice usage temporarily unavailable' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns a retryable failure instead of a paywall when RevenueCat returns malformed data', async () => {
        process.env.REVENUECAT_API_KEY = 'revenuecat-test-key';
        fetchMock.mockImplementation((url: string) => {
            if (isCustomerRequest(url)) {
                return Promise.resolve(activeEntitlementsResponse());
            }
            if (url.includes('/subscriptions')) {
                return Promise.resolve(jsonResponse({}));
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const response = await app.inject({
            method: 'GET',
            url: '/v1/voice/usage',
            headers: { authorization: 'Bearer test' },
        });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ error: 'Subscription status temporarily unavailable' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('keeps free voice available below the free limit during a RevenueCat outage', async () => {
        process.env.REVENUECAT_API_KEY = 'revenuecat-test-key';
        fetchMock.mockImplementation((url: string) => {
            if (isCustomerRequest(url)) {
                return Promise.resolve(jsonResponse({ error: 'rate limited' }, 429));
            }
            if (url.includes('/subscriptions')) {
                return Promise.resolve(jsonResponse({ error: 'rate limited' }, 429));
            }
            if (url.includes('/conversations?')) {
                return Promise.resolve(jsonResponse({ conversations: [] }));
            }
            if (url.includes('/conversation/token?')) {
                return Promise.resolve(jsonResponse({
                    token: 'free-fallback-token',
                    conversation_id: 'conv_freefallback123',
                }));
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const response = await app.inject({
            method: 'POST',
            url: '/v1/voice/conversations',
            headers: { authorization: 'Bearer test' },
            payload: { agentId: AGENT_ID },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            allowed: true,
            conversationId: 'conv_freefallback123',
            limitSeconds: 1200,
        });
    });

    it('fails retryably above the free limit when RevenueCat is unavailable', async () => {
        process.env.REVENUECAT_API_KEY = 'revenuecat-test-key';
        fetchMock.mockImplementation((url: string) => {
            if (isCustomerRequest(url) || url.includes('/subscriptions')) {
                return Promise.resolve(jsonResponse({ error: 'rate limited' }, 429));
            }
            if (url.includes('/conversations?')) {
                return Promise.resolve(jsonResponse({
                    conversations: [{ start_time_unix_secs: Math.floor(Date.now() / 1000), call_duration_secs: 1200 }],
                }));
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const response = await app.inject({
            method: 'POST',
            url: '/v1/voice/conversations',
            headers: { authorization: 'Bearer test' },
            payload: { agentId: AGENT_ID },
        });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ error: 'Subscription status temporarily unavailable' });
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/conversation/token?'))).toBe(false);
    });

    it('rejects malformed token responses as retryable service failures', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse({ conversations: [] }))
            .mockResolvedValueOnce(jsonResponse({ token: '' }));

        const response = await app.inject({
            method: 'POST',
            url: '/v1/voice/conversations',
            headers: { authorization: 'Bearer test' },
            payload: { agentId: AGENT_ID },
        });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ error: 'Voice service temporarily unavailable' });
    });

    it('does not disclose missing secret names to clients', async () => {
        delete process.env.ELEVENLABS_API_KEY;

        const response = await app.inject({
            method: 'POST',
            url: '/v1/voice/conversations',
            headers: { authorization: 'Bearer test' },
            payload: { agentId: AGENT_ID },
        });

        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({ error: 'Voice service unavailable' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns validated usage and the paid limit for an active subscriber', async () => {
        process.env.REVENUECAT_API_KEY = 'revenuecat-test-key';
        const periodStartedAt = Date.now() - 5 * 86400_000;
        fetchMock.mockImplementation((url: string) => {
            if (isCustomerRequest(url)) {
                return Promise.resolve(activeEntitlementsResponse());
            }
            if (url.includes('/subscriptions')) {
                return Promise.resolve(subscriptionsResponse(periodStartedAt));
            }
            return Promise.resolve(jsonResponse({
                conversations: [{ start_time_unix_secs: Math.floor(Date.now() / 1000), call_duration_secs: 42 }],
            }));
        });

        const response = await app.inject({
            method: 'GET',
            url: '/v1/voice/usage',
            headers: { authorization: 'Bearer test' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            usedSeconds: 42,
            limitSeconds: 18_000,
            conversationCount: 1,
            conversationLimit: 100,
        });
        const usageCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/conversations?'));
        expect(new URL(usageCall![0] as string).searchParams.get('call_start_after_unix'))
            .toBe(String(Math.floor(periodStartedAt / 1000) - 18_000));
    });

    it('resets paid usage and call count at a renewed billing-period boundary', async () => {
        process.env.REVENUECAT_API_KEY = 'revenuecat-test-key';
        const renewedAt = Date.now() - 60_000;
        fetchMock.mockImplementation((url: string) => {
            if (isCustomerRequest(url)) {
                return Promise.resolve(activeEntitlementsResponse());
            }
            if (url.includes('/subscriptions')) {
                return Promise.resolve(subscriptionsResponse(renewedAt));
            }
            if (url.includes('/conversations?')) {
                return Promise.resolve(jsonResponse({ conversations: [] }));
            }
            if (url.includes('/conversation/token?')) {
                return Promise.resolve(jsonResponse({
                    token: 'renewed-period-token',
                    conversation_id: 'conv_renewed123',
                }));
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const response = await app.inject({
            method: 'POST',
            url: '/v1/voice/conversations',
            headers: { authorization: 'Bearer test' },
            payload: { agentId: AGENT_ID },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            allowed: true,
            usedSeconds: 0,
            limitSeconds: 18_000,
            conversationId: 'conv_renewed123',
        });
        const usageCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/conversations?'));
        expect(new URL(usageCall![0] as string).searchParams.get('call_start_after_unix'))
            .toBe(String(Math.floor(renewedAt / 1000) - 18_000));
    });

    it('still enforces the paid hard limit inside the renewed billing period', async () => {
        process.env.REVENUECAT_API_KEY = 'revenuecat-test-key';
        const renewedAt = Date.now() - 86400_000;
        fetchMock.mockImplementation((url: string) => {
            if (isCustomerRequest(url)) {
                return Promise.resolve(activeEntitlementsResponse());
            }
            if (url.includes('/subscriptions')) {
                return Promise.resolve(subscriptionsResponse(renewedAt));
            }
            if (url.includes('/conversations?')) {
                return Promise.resolve(jsonResponse({
                    conversations: [{ start_time_unix_secs: Math.floor(Date.now() / 1000), call_duration_secs: 18_000 }],
                }));
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const response = await app.inject({
            method: 'POST',
            url: '/v1/voice/conversations',
            headers: { authorization: 'Bearer test' },
            payload: { agentId: AGENT_ID },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            allowed: false,
            reason: 'voice_hard_limit_reached',
            usedSeconds: 18_000,
            limitSeconds: 18_000,
        });
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/conversation/token?'))).toBe(false);
    });

    it('treats an active entitlement without a subscription as paid in a rolling window', async () => {
        process.env.REVENUECAT_API_KEY = 'revenuecat-test-key';
        fetchMock.mockImplementation((url: string) => {
            if (isCustomerRequest(url)) {
                return Promise.resolve(activeEntitlementsResponse());
            }
            if (url.includes('/subscriptions')) {
                return Promise.resolve(jsonResponse({ items: [] }));
            }
            if (url.includes('/conversations?')) {
                return Promise.resolve(jsonResponse({ conversations: [] }));
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const response = await app.inject({
            method: 'GET',
            url: '/v1/voice/usage',
            headers: { authorization: 'Bearer test' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            limitSeconds: 18_000,
            usedSeconds: 0,
        });
        const usageCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/conversations?'));
        const afterUnix = Number(new URL(usageCall![0] as string).searchParams.get('call_start_after_unix'));
        expect(afterUnix).toBeGreaterThan(Math.floor(Date.now() / 1000) - 31 * 86400);
    });

    it('accepts an access-granting subscription with an indefinite period end', async () => {
        process.env.REVENUECAT_API_KEY = 'revenuecat-test-key';
        const periodStartedAt = Date.now() - 86400_000;
        fetchMock.mockImplementation((url: string) => {
            if (isCustomerRequest(url)) {
                return Promise.resolve(activeEntitlementsResponse());
            }
            if (url.includes('/subscriptions')) {
                return Promise.resolve(jsonResponse({
                    items: [{
                        current_period_starts_at: periodStartedAt,
                        current_period_ends_at: null,
                        gives_access: true,
                        status: 'paused',
                        entitlements: { items: [{ id: 'pro' }] },
                    }],
                }));
            }
            if (url.includes('/conversations?')) {
                return Promise.resolve(jsonResponse({ conversations: [] }));
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const response = await app.inject({
            method: 'GET',
            url: '/v1/voice/usage',
            headers: { authorization: 'Bearer test' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ limitSeconds: 18_000 });
        const usageCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/conversations?'));
        expect(new URL(usageCall![0] as string).searchParams.get('call_start_after_unix'))
            .toBe(String(Math.floor(periodStartedAt / 1000) - 18_000));
    });

    it('ignores a future period and chooses the latest already-started period', async () => {
        process.env.REVENUECAT_API_KEY = 'revenuecat-test-key';
        const currentPeriodStartedAt = Date.now() - 86400_000;
        const futurePeriodStartedAt = Date.now() + 60_000;
        fetchMock.mockImplementation((url: string) => {
            if (isCustomerRequest(url)) {
                return Promise.resolve(activeEntitlementsResponse());
            }
            if (url.includes('/subscriptions')) {
                return Promise.resolve(jsonResponse({
                    items: [
                        {
                            current_period_starts_at: futurePeriodStartedAt,
                            current_period_ends_at: futurePeriodStartedAt + 30 * 86400_000,
                            gives_access: true,
                            status: 'incomplete',
                            entitlements: { items: [{ id: 'pro' }] },
                        },
                        {
                            current_period_starts_at: currentPeriodStartedAt,
                            current_period_ends_at: currentPeriodStartedAt + 30 * 86400_000,
                            gives_access: true,
                            status: 'active',
                            entitlements: { items: [{ id: 'pro' }] },
                        },
                    ],
                }));
            }
            if (url.includes('/conversations?')) {
                return Promise.resolve(jsonResponse({ conversations: [] }));
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const response = await app.inject({
            method: 'GET',
            url: '/v1/voice/usage',
            headers: { authorization: 'Bearer test' },
        });

        expect(response.statusCode).toBe(200);
        const usageCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/conversations?'));
        expect(new URL(usageCall![0] as string).searchParams.get('call_start_after_unix'))
            .toBe(String(Math.floor(currentPeriodStartedAt / 1000) - 18_000));
    });

    it('fails closed when RevenueCat indicates truncated subscription data', async () => {
        process.env.REVENUECAT_API_KEY = 'revenuecat-test-key';
        const periodStartedAt = Date.now() - 86400_000;
        fetchMock.mockImplementation((url: string) => {
            if (isCustomerRequest(url)) {
                return Promise.resolve(jsonResponse({
                    active_entitlements: {
                        items: [{ entitlement_id: 'pro' }],
                        next_page: '/v2/projects/test/customers/test/active_entitlements?starting_after=pro',
                    },
                }));
            }
            if (url.includes('/subscriptions')) {
                return Promise.resolve(subscriptionsResponse(periodStartedAt));
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const response = await app.inject({
            method: 'GET',
            url: '/v1/voice/usage',
            headers: { authorization: 'Bearer test' },
        });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ error: 'Subscription status temporarily unavailable' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('fails closed when the subscription list has another page', async () => {
        process.env.REVENUECAT_API_KEY = 'revenuecat-test-key';
        const periodStartedAt = Date.now() - 86400_000;
        fetchMock.mockImplementation((url: string) => {
            if (isCustomerRequest(url)) {
                return Promise.resolve(activeEntitlementsResponse());
            }
            if (url.includes('/subscriptions')) {
                return Promise.resolve(jsonResponse({
                    items: [{
                        current_period_starts_at: periodStartedAt,
                        current_period_ends_at: periodStartedAt + 30 * 86400_000,
                        gives_access: true,
                        status: 'active',
                        entitlements: { items: [{ id: 'pro' }] },
                    }],
                    next_page: '/v2/projects/test/customers/test/subscriptions?starting_after=sub',
                }));
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const response = await app.inject({
            method: 'GET',
            url: '/v1/voice/usage',
            headers: { authorization: 'Bearer test' },
        });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ error: 'Subscription status temporarily unavailable' });
    });

    it('fails closed when an access-granting subscription has more entitlements', async () => {
        process.env.REVENUECAT_API_KEY = 'revenuecat-test-key';
        const periodStartedAt = Date.now() - 86400_000;
        fetchMock.mockImplementation((url: string) => {
            if (isCustomerRequest(url)) {
                return Promise.resolve(activeEntitlementsResponse());
            }
            if (url.includes('/subscriptions')) {
                return Promise.resolve(jsonResponse({
                    items: [{
                        current_period_starts_at: periodStartedAt,
                        current_period_ends_at: periodStartedAt + 30 * 86400_000,
                        gives_access: true,
                        status: 'active',
                        entitlements: {
                            items: [{ id: 'pro' }],
                            next_page: '/v2/projects/test/entitlements?starting_after=pro',
                        },
                    }],
                }));
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const response = await app.inject({
            method: 'GET',
            url: '/v1/voice/usage',
            headers: { authorization: 'Bearer test' },
        });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ error: 'Subscription status temporarily unavailable' });
    });

    it('returns free-tier usage when RevenueCat is not configured', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({
            conversations: [{ start_time_unix_secs: Math.floor(Date.now() / 1000), call_duration_secs: 42 }],
        }));

        const response = await app.inject({
            method: 'GET',
            url: '/v1/voice/usage',
            headers: { authorization: 'Bearer test' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            usedSeconds: 42,
            limitSeconds: 1200,
            conversationCount: 1,
        });
    });
});
