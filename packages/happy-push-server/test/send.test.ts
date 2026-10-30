import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { resetApnsCache } from '@/providers/apns';
import { resetFcmCache } from '@/providers/fcm';
import { recordDeliveries } from '@/storage/devices';
import { parsePushToken } from '@/token';
import {
    APP_ID,
    EXPO_TOKEN,
    FCM_TOKEN,
    IOS_TOKEN,
    androidDevice,
    createHarness,
    decodeJwt,
    expoDevice,
    expoOk,
    fakeRateLimiter,
    deviceRow,
    generateApnsKey,
    generateServiceAccount,
    iosDevice,
    json,
    mockProviders,
    oauthOk,
    postJson,
    verifyJwt,
    type Harness,
} from './helpers';

interface Ticket {
    status: 'ok' | 'error';
    id?: string;
    message?: string;
    details?: { error?: string; provider?: string; reason?: string };
}

let apnsKey: Awaited<ReturnType<typeof generateApnsKey>>;
let serviceAccount: Awaited<ReturnType<typeof generateServiceAccount>>;

beforeAll(async () => {
    apnsKey = await generateApnsKey();
    serviceAccount = await generateServiceAccount();
});

beforeEach(() => {
    resetApnsCache();
    resetFcmCache();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function configured(env: Partial<Env> = {}): Harness {
    return createHarness({
        APNS_KEY_ID: 'ABC123DEFG',
        APNS_TEAM_ID: 'TEAM123456',
        APNS_PRIVATE_KEY: apnsKey.pem,
        FCM_SERVICE_ACCOUNT: serviceAccount.json,
        ...env,
    });
}

async function tickets(response: Response): Promise<Ticket[]> {
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: Ticket[] }).data;
}

describe('POST /v1/push/send rate limiting', () => {
    it('needs no credentials', async () => {
        const h = configured();
        mockProviders({ apns: () => new Response(null, { status: 200 }) });
        const token = await h.register(iosDevice());
        const response = await postJson(h.request, '/v1/push/send', { to: token, title: 'hi' });
        expect((await tickets(response))[0]!.status).toBe('ok');
    });

    it('limits per recipient token and skips the provider for over-limit recipients', async () => {
        const limiter = fakeRateLimiter(2);
        const h = configured({ SEND_RATE_LIMITER: limiter });
        const providers = mockProviders({ apns: () => new Response(null, { status: 200 }) });
        const a = await h.register(iosDevice());
        const b = await h.register(iosDevice({ deviceId: 'ios-device-0002', pushToken: 'b'.repeat(64) }));

        const result = await tickets(await h.send({ to: [a, a, a, b], title: 'hi' }));
        expect(result.map((t) => t.status === 'ok' ? 'ok' : t.details?.error)).toEqual(['ok', 'ok', 'MessageRateExceeded', 'ok']);
        expect(result[2]).toMatchObject({ details: { reason: 'RecipientRateLimited' } });
        expect(providers.apnsCalls()).toHaveLength(3);
        expect(new Set(limiter.keys)).toEqual(new Set([`send:${parsePushToken(a)}`, `send:${parsePushToken(b)}`]));
        // Rate limiting is not a dead token: the install stays active.
        expect(deviceRow(h, a)).toMatchObject({ active: 1 });
    });

    it('does not consult the limiter for unknown tokens', async () => {
        const limiter = fakeRateLimiter(0);
        const h = configured({ SEND_RATE_LIMITER: limiter });
        mockProviders({});
        const [ticket] = await tickets(await h.send({ to: 'HappyPushToken[0123456789ABCDEFGHIJKL]', title: 'hi' }));
        expect(ticket).toMatchObject({ details: { error: 'DeviceNotRegistered' } });
        expect(limiter.keys).toEqual([]);
    });

    it('sends anyway when the limiter itself fails', async () => {
        const h = configured({ SEND_RATE_LIMITER: { limit: async () => { throw new Error('limiter down'); } } });
        mockProviders({ apns: () => new Response(null, { status: 200 }) });
        const [ticket] = await tickets(await h.send({ to: await h.register(iosDevice()), title: 'hi' }));
        expect(ticket!.status).toBe('ok');
    });
});

describe('POST /v1/push/send validation', () => {
    it('rejects more than 100 recipients', async () => {
        const h = configured();
        const to = Array.from({ length: 60 }, (_, i) => `HappyPushToken[${i}]`);
        const response = await h.send([{ to, title: 'a' }, { to, title: 'b' }]);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ errors: [{ code: 'PUSH_TOO_MANY_NOTIFICATIONS' }] });
    });

    it('rejects malformed messages', async () => {
        const h = configured();
        const response = await h.send({ to: 'HappyPushToken[x]', badge: 'three' });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ errors: [{ code: 'VALIDATION_ERROR', details: [{ path: '0.badge' }] }] });
    });

    it.each([
        ['an unknown field', { richContent: { image: 'x' } }, '0'],
        ["Expo's priority 'default'", { priority: 'default' }, '0.priority'],
        ["Expo's expiration", { expiration: 1 }, '0'],
        ["Expo's _contentAvailable", { _contentAvailable: true }, '0'],
    ])('rejects %s', async (_name, fields, path) => {
        const h = configured();
        const providers = mockProviders({});
        const response = await h.send({ to: 'HappyPushToken[x]', title: 'hi', ...fields });
        expect(response.status).toBe(400);
        const json = await response.json() as { errors: Array<{ code: string; details: Array<{ path: string }> }> };
        expect(json.errors[0]!.code).toBe('VALIDATION_ERROR');
        expect(json.errors[0]!.details.map((d) => d.path)).toContain(path);
        expect(providers.calls).toHaveLength(0);
    });

    it("accepts the message happy-server sends today", async () => {
        const h = configured();
        mockProviders({ apns: () => new Response(null, { status: 200 }) });
        const token = await h.register(iosDevice());
        const result = await tickets(await h.send([{
            to: token,
            title: "It's ready!",
            body: 'Claude finished',
            data: { sessionId: 'sess_1' },
            sound: 'default',
            channelId: 'messages',
        }]));
        expect(result).toEqual([{ status: 'ok', id: expect.any(String) }]);
    });

    it('answers unknown, malformed, and non-Happy tokens with DeviceNotRegistered without calling a provider', async () => {
        const h = configured();
        const providers = mockProviders({});
        const result = await tickets(await h.send([
            { to: 'HappyPushToken[0123456789ABCDEFGHIJKL]', title: 'unknown' },
            { to: 'HappyPushToken[short]', title: 'malformed' },
            { to: 'ExponentPushToken[abc]', title: 'expo' },
        ]));
        expect(result).toHaveLength(3);
        for (const ticket of result) {
            expect(ticket).toMatchObject({ status: 'error', details: { error: 'DeviceNotRegistered' } });
        }
        expect(result[2]!.message).toBe('"ExponentPushToken[abc]" is not a registered push notification recipient');
        expect(providers.calls).toHaveLength(0);
    });
});

describe('APNs delivery', () => {
    it('delivers with the expo-notifications payload layout and returns the apns-id as the ticket id', async () => {
        const h = configured();
        const providers = mockProviders({ apns: () => new Response(null, { status: 200 }) });
        const token = await h.register(iosDevice());

        const result = await tickets(await h.send({
            to: token,
            title: "It's ready!",
            subtitle: 'happy',
            body: 'Claude finished',
            data: { sessionId: 'sess_1', nested: { a: 1 } },
            sound: 'default',
            badge: 3,
            categoryId: 'session',
            threadId: 'sess_1',
            mutableContent: true,
            ttl: 60,
        }));

        expect(result).toEqual([{ status: 'ok', id: expect.stringMatching(/^[0-9a-f-]{36}$/) }]);
        const [call] = providers.apnsCalls();
        expect(call!.url).toBe(`https://api.push.apple.com/3/device/${IOS_TOKEN}`);
        expect(call!.headers).toMatchObject({
            'apns-topic': APP_ID,
            'apns-push-type': 'alert',
            'apns-priority': '10',
            'apns-id': result[0]!.id,
            'apns-expiration': String(Math.floor(Date.now() / 1000) + 60),
        });
        expect(JSON.parse(call!.body)).toEqual({
            aps: {
                alert: { title: "It's ready!", subtitle: 'happy', body: 'Claude finished' },
                sound: 'default',
                badge: 3,
                category: 'session',
                'thread-id': 'sess_1',
                'mutable-content': 1,
            },
            // expo-notifications reads request.content.data from here on iOS.
            body: { sessionId: 'sess_1', nested: { a: 1 } },
        });
        expect(deviceRow(h, token)!.last_sent_at).toBe(Date.now());
    });

    it('signs a valid ES256 provider token', async () => {
        const h = configured();
        const providers = mockProviders({ apns: () => new Response(null, { status: 200 }) });
        await h.send({ to: await h.register(iosDevice()), title: 'hi' });

        const authorization = providers.apnsCalls()[0]!.headers.authorization!;
        expect(authorization).toMatch(/^bearer /);
        const jwt = authorization.slice('bearer '.length);
        const { header, claims } = decodeJwt(jwt);
        expect(header).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' });
        expect(claims).toEqual({ iss: 'TEAM123456', iat: Math.floor(Date.now() / 1000) });
        expect(await verifyJwt(jwt, apnsKey.publicKey)).toBe(true);
    });

    it('caches the provider token for 50 minutes across requests', async () => {
        const h = configured();
        const providers = mockProviders({ apns: () => new Response(null, { status: 200 }) });
        const token = await h.register(iosDevice());
        const second = await h.register(iosDevice({ deviceId: 'ios-device-0002', pushToken: 'b'.repeat(64) }));

        await h.send([{ to: token, title: 'one' }, { to: second, title: 'one' }]);
        vi.advanceTimersByTime(49 * 60 * 1000);
        await h.send({ to: token, title: 'two' });
        vi.advanceTimersByTime(2 * 60 * 1000);
        await h.send({ to: token, title: 'three' });

        const auth = providers.apnsCalls().map((c) => c.headers.authorization);
        expect(auth).toHaveLength(4);
        expect(new Set(auth.slice(0, 3)).size).toBe(1);
        expect(auth[3]).not.toBe(auth[0]);
    });

    it('uses the sandbox host for development installs', async () => {
        const h = configured();
        const providers = mockProviders({ apns: () => new Response(null, { status: 200 }) });
        await h.send({ to: await h.register(iosDevice({ environment: 'development' })), title: 'hi' });
        expect(providers.apnsCalls()[0]!.url).toBe(`https://api.sandbox.push.apple.com/3/device/${IOS_TOKEN}`);
    });

    it('sends data-only messages as background pushes', async () => {
        const h = configured();
        const providers = mockProviders({ apns: () => new Response(null, { status: 200 }) });
        await h.send({ to: await h.register(iosDevice()), data: { refresh: true }, priority: 'high' });
        const [call] = providers.apnsCalls();
        expect(call!.headers).toMatchObject({ 'apns-push-type': 'background', 'apns-priority': '5' });
        expect(call!.headers['apns-expiration']).toBeUndefined();
        expect(JSON.parse(call!.body)).toEqual({ aps: { 'content-available': 1 }, body: { refresh: true } });
    });

    it.each([
        [410, 'Unregistered'],
        [400, 'BadDeviceToken'],
        [410, 'ExpiredToken'],
        [400, 'DeviceTokenNotForTopic'],
    ])('deactivates the install on %i %s and reports DeviceNotRegistered', async (status, reason) => {
        const h = configured();
        const providers = mockProviders({ apns: () => json({ reason }, status) });
        const token = await h.register(iosDevice());

        const [ticket] = await tickets(await h.send({ to: token, title: 'hi' }));
        expect(ticket).toMatchObject({ status: 'error', details: { error: 'DeviceNotRegistered', provider: 'apns', reason } });
        expect(deviceRow(h, token)).toMatchObject({ active: 0, inactive_reason: `apns:${reason}` });

        // Inactive installs are answered locally from then on.
        const [again] = await tickets(await h.send({ to: token, title: 'hi' }));
        expect(again).toMatchObject({ status: 'error', details: { error: 'DeviceNotRegistered' } });
        expect(providers.apnsCalls()).toHaveLength(1);

        // Re-registering revives the same token.
        expect(await h.register(iosDevice({ pushToken: 'd'.repeat(64) }))).toBe(token);
        expect(deviceRow(h, token)).toMatchObject({ active: 1, last_error: null });
    });

    it.each([
        [403, 'ExpiredProviderToken', 'InvalidCredentials'],
        [403, 'InvalidProviderToken', 'InvalidCredentials'],
        [413, 'PayloadTooLarge', 'MessageTooBig'],
        [429, 'TooManyRequests', 'MessageRateExceeded'],
        [500, 'InternalServerError', undefined],
        [503, 'ServiceUnavailable', undefined],
    ])('maps %i %s to %s and keeps the install active', async (status, reason, error) => {
        const h = configured();
        mockProviders({ apns: () => json({ reason }, status) });
        const token = await h.register(iosDevice());

        const [ticket] = await tickets(await h.send({ to: token, title: 'hi' }));
        expect(ticket!.status).toBe('error');
        expect(ticket!.details).toEqual({ provider: 'apns', reason, ...(error ? { error } : {}) });
        expect(deviceRow(h, token)).toMatchObject({ active: 1, last_error: `apns:${reason}` });
    });

    it('drops a rejected provider token so the next request signs a new one', async () => {
        const h = configured();
        let reject = true;
        const providers = mockProviders({
            apns: () => reject ? json({ reason: 'ExpiredProviderToken' }, 403) : new Response(null, { status: 200 }),
        });
        const token = await h.register(iosDevice());
        await h.send({ to: token, title: 'one' });
        reject = false;
        vi.advanceTimersByTime(1000);
        const [ticket] = await tickets(await h.send({ to: token, title: 'two' }));
        expect(ticket!.status).toBe('ok');
        const [first, second] = providers.apnsCalls().map((c) => c.headers.authorization);
        expect(second).not.toBe(first);
    });

    it('reports network failures without deactivating', async () => {
        const h = configured();
        mockProviders({ apns: () => { throw new TypeError('fetch failed'); } });
        const token = await h.register(iosDevice());
        const [ticket] = await tickets(await h.send({ to: token, title: 'hi' }));
        expect(ticket).toMatchObject({ status: 'error', details: { provider: 'apns', reason: 'NetworkError' } });
        expect(ticket!.details!.error).toBeUndefined();
        expect(deviceRow(h, token)).toMatchObject({ active: 1 });
    });

    it('rejects payloads over 4KB as MessageTooBig without calling APNs', async () => {
        const h = configured();
        const providers = mockProviders({ apns: () => new Response(null, { status: 200 }) });
        const token = await h.register(iosDevice());
        const [ticket] = await tickets(await h.send({ to: token, title: 'hi', data: { blob: 'x'.repeat(4100) } }));
        expect(ticket).toMatchObject({ status: 'error', details: { error: 'MessageTooBig' } });
        expect(providers.apnsCalls()).toHaveLength(0);
    });

    it('answers InvalidCredentials when APNs is not configured', async () => {
        const h = createHarness();
        const providers = mockProviders({});
        const token = await h.register(iosDevice());
        const [ticket] = await tickets(await h.send({ to: token, title: 'hi' }));
        expect(ticket).toMatchObject({ status: 'error', details: { error: 'InvalidCredentials', provider: 'apns' } });
        expect(providers.calls).toHaveLength(0);
    });

    it('answers InvalidCredentials when the APNs key is garbage', async () => {
        const h = createHarness({ APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' });
        mockProviders({});
        const [ticket] = await tickets(await h.send({ to: await h.register(iosDevice()), title: 'hi' }));
        expect(ticket).toMatchObject({ status: 'error', details: { error: 'InvalidCredentials' } });
    });
});

describe('FCM delivery', () => {
    function fcmOk() {
        return json({ name: 'projects/happy-test/messages/0:1' });
    }

    it('delivers a data message expo-notifications can render', async () => {
        const h = configured();
        const providers = mockProviders({ oauth: () => oauthOk(), fcm: fcmOk });
        const token = await h.register(androidDevice());

        const result = await tickets(await h.send({
            to: token,
            title: "It's ready!",
            body: 'Claude finished',
            data: { sessionId: 'sess_1', count: 2 },
            sound: 'default',
            channelId: 'messages',
            badge: 1,
            ttl: 120,
        }));

        expect(result).toEqual([{ status: 'ok', id: expect.any(String) }]);
        const [call] = providers.fcmCalls();
        expect(call!.url).toBe('https://fcm.googleapis.com/v1/projects/happy-test/messages:send');
        expect(call!.headers.authorization).toBe('Bearer ya29.test-access-token');
        expect(JSON.parse(call!.body)).toEqual({
            message: {
                token: FCM_TOKEN,
                data: {
                    title: "It's ready!",
                    message: 'Claude finished',
                    // expo-notifications JSON-parses this into request.content.data.
                    body: JSON.stringify({ sessionId: 'sess_1', count: 2 }),
                    channelId: 'messages',
                    badge: '1',
                },
                android: { priority: 'HIGH', ttl: '120s' },
            },
        });
        expect(deviceRow(h, token)!.last_sent_at).toBe(Date.now());
    });

    it('requests a valid service-account assertion and caches the access token ~55 minutes', async () => {
        const h = configured();
        let issued = 0;
        const providers = mockProviders({ oauth: () => oauthOk(`token-${++issued}`), fcm: fcmOk });
        const token = await h.register(androidDevice());
        const second = await h.register(androidDevice({ deviceId: 'android-device-0002', pushToken: 'other-' + 'y'.repeat(140) }));

        await h.send([{ to: token, title: 'a' }, { to: second, title: 'a' }]);
        vi.advanceTimersByTime(54 * 60 * 1000);
        await h.send({ to: token, title: 'b' });
        vi.advanceTimersByTime(2 * 60 * 1000);
        await h.send({ to: token, title: 'c' });

        expect(providers.oauthCalls()).toHaveLength(2);
        expect(providers.fcmCalls().map((c) => c.headers.authorization)).toEqual([
            'Bearer token-1', 'Bearer token-1', 'Bearer token-1', 'Bearer token-2',
        ]);

        const form = new URLSearchParams(providers.oauthCalls()[0]!.body);
        expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
        const assertion = form.get('assertion')!;
        const { header, claims } = decodeJwt(assertion);
        expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
        expect(claims).toMatchObject({
            iss: serviceAccount.account.client_email,
            scope: 'https://www.googleapis.com/auth/firebase.messaging',
            aud: 'https://oauth2.googleapis.com/token',
        });
        expect(claims.exp - claims.iat).toBe(3600);
        expect(await verifyJwt(assertion, serviceAccount.publicKey)).toBe(true);
    });

    it.each([
        ['404 UNREGISTERED', 404, { status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] }],
        ['400 invalid registration token', 400, { status: 'INVALID_ARGUMENT', message: 'The registration token is not a valid FCM registration token', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'INVALID_ARGUMENT' }] }],
    ])('deactivates the install on %s', async (_name, status, error) => {
        const h = configured();
        mockProviders({ oauth: () => oauthOk(), fcm: () => json({ error: { code: status, ...error } }, status) });
        const token = await h.register(androidDevice());

        const [ticket] = await tickets(await h.send({ to: token, title: 'hi' }));
        expect(ticket).toMatchObject({ status: 'error', details: { error: 'DeviceNotRegistered', provider: 'fcm' } });
        expect(deviceRow(h, token)).toMatchObject({ active: 0 });
    });

    it.each([
        ['400 invalid payload', 400, { status: 'INVALID_ARGUMENT', message: 'Invalid value at message.android.ttl' }, undefined],
        ['403 SENDER_ID_MISMATCH', 403, { status: 'PERMISSION_DENIED', message: 'SenderId mismatch', details: [{ errorCode: 'SENDER_ID_MISMATCH' }] }, 'MismatchSenderId'],
        ['429 QUOTA_EXCEEDED', 429, { status: 'RESOURCE_EXHAUSTED', message: 'quota', details: [{ errorCode: 'QUOTA_EXCEEDED' }] }, 'MessageRateExceeded'],
        ['401 UNAUTHENTICATED', 401, { status: 'UNAUTHENTICATED', message: 'bad token' }, 'InvalidCredentials'],
        ['503 UNAVAILABLE', 503, { status: 'UNAVAILABLE', message: 'try later', details: [{ errorCode: 'UNAVAILABLE' }] }, undefined],
    ])('maps %s and keeps the install active', async (_name, status, error, code) => {
        const h = configured();
        mockProviders({ oauth: () => oauthOk(), fcm: () => json({ error: { code: status, ...error } }, status) });
        const token = await h.register(androidDevice());

        const [ticket] = await tickets(await h.send({ to: token, title: 'hi' }));
        expect(ticket!.status).toBe('error');
        expect(ticket!.details!.error).toBe(code);
        expect(deviceRow(h, token)).toMatchObject({ active: 1 });
    });

    it('fetches a fresh access token after FCM rejects one', async () => {
        const h = configured();
        let issued = 0;
        let reject = true;
        const providers = mockProviders({
            oauth: () => oauthOk(`token-${++issued}`),
            fcm: () => reject ? json({ error: { code: 401, status: 'UNAUTHENTICATED' } }, 401) : fcmOk(),
        });
        const token = await h.register(androidDevice());
        await h.send({ to: token, title: 'one' });
        reject = false;
        const [ticket] = await tickets(await h.send({ to: token, title: 'two' }));
        expect(ticket!.status).toBe('ok');
        expect(providers.fcmCalls().map((c) => c.headers.authorization)).toEqual(['Bearer token-1', 'Bearer token-2']);
    });

    it('answers InvalidCredentials for every android recipient when OAuth fails, fetching once', async () => {
        const h = configured();
        const providers = mockProviders({ oauth: () => json({ error: 'invalid_grant' }, 400), fcm: fcmOk });
        const a = await h.register(androidDevice());
        const b = await h.register(androidDevice({ deviceId: 'android-device-0002', pushToken: 'other-' + 'y'.repeat(140) }));

        const result = await tickets(await h.send({ to: [a, b], title: 'hi' }));
        expect(result).toHaveLength(2);
        for (const ticket of result) {
            expect(ticket).toMatchObject({ status: 'error', details: { error: 'InvalidCredentials', provider: 'fcm' } });
        }
        expect(providers.oauthCalls()).toHaveLength(1);
        expect(providers.fcmCalls()).toHaveLength(0);
    });

    it('answers InvalidCredentials when FCM_SERVICE_ACCOUNT is missing or malformed', async () => {
        mockProviders({});
        for (const value of [undefined, 'not json', JSON.stringify({ project_id: 'x' })]) {
            const h = createHarness({ FCM_SERVICE_ACCOUNT: value });
            const [ticket] = await tickets(await h.send({ to: await h.register(androidDevice()), title: 'hi' }));
            expect(ticket).toMatchObject({ status: 'error', details: { error: 'InvalidCredentials', provider: 'fcm' } });
        }
    });
});

describe('fan-out', () => {
    it('returns one ticket per recipient in request order across platforms', async () => {
        const h = configured();
        mockProviders({
            oauth: () => oauthOk(),
            fcm: () => json({ name: 'projects/happy-test/messages/1' }),
            apns: (request) => request.url.endsWith('b'.repeat(64)) ? json({ reason: 'Unregistered' }, 410) : new Response(null, { status: 200 }),
        });
        const ios = await h.register(iosDevice());
        const deadIos = await h.register(iosDevice({ deviceId: 'ios-device-0002', pushToken: 'b'.repeat(64) }));
        const android = await h.register(androidDevice());

        const result = await tickets(await h.send([
            { to: [ios, 'HappyPushToken[nope]', android], title: 'first' },
            { to: deadIos, title: 'second' },
            { to: ios, title: 'third' },
        ]));

        expect(result.map((t) => t.status === 'ok' ? 'ok' : t.details?.error)).toEqual([
            'ok', 'DeviceNotRegistered', 'ok', 'DeviceNotRegistered', 'ok',
        ]);
        expect(new Set(result.filter((t) => t.status === 'ok').map((t) => t.id)).size).toBe(3);
    });

    it('keeps at most 6 provider requests in flight', async () => {
        const h = configured();
        let inFlight = 0;
        let maxInFlight = 0;
        mockProviders({
            apns: async () => {
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise((resolve) => setTimeout(resolve, 5));
                inFlight--;
                return new Response(null, { status: 200 });
            },
        });
        const tokens: string[] = [];
        for (let i = 0; i < 20; i++) {
            tokens.push(await h.register(iosDevice({ deviceId: `ios-device-${1000 + i}`, pushToken: i.toString(16).padStart(64, '0') })));
        }
        const result = await tickets(await h.send({ to: tokens, title: 'hi' }));
        expect(result.every((t) => t.status === 'ok')).toBe(true);
        expect(maxInFlight).toBe(6);
    });
});

describe('recordDeliveries', () => {
    it('does not deactivate an install whose push token changed while the send was in flight', async () => {
        const h = configured();
        const token = await h.register(iosDevice());
        const id = parsePushToken(token)!;
        const stale = { id, appId: APP_ID, platform: 'ios' as const, provider: 'apns' as const, environment: 'production' as const, pushToken: IOS_TOKEN, active: true };

        await h.register(iosDevice({ pushToken: 'e'.repeat(64) }));
        await recordDeliveries(h.db, [{ kind: 'unregistered', device: stale, error: 'apns:Unregistered' }], Date.now());

        expect(deviceRow(h, token)).toMatchObject({ active: 1, push_token: 'e'.repeat(64) });
    });
});

describe('Expo forwarding', () => {
    const EXPO_TOKEN_2 = 'ExpoPushToken[zzzzzzzzzzzzzzzzzzzzzz]';

    it('forwards to Expo without credentials and returns Expo ticket ids', async () => {
        // No APNs/FCM credentials at all: Expo installs do not need them.
        const h = createHarness();
        const providers = mockProviders({ expo: expoOk });
        const token = await h.register(expoDevice());

        const result = await tickets(await h.send({
            to: token,
            title: "It's ready!",
            subtitle: 'happy',
            body: 'Claude finished',
            data: { sessionId: 'sess_1' },
            sound: 'default',
            badge: 2,
            channelId: 'messages',
            categoryId: 'session',
            threadId: 'sess_1',
            ttl: 60,
            mutableContent: true,
            interruptionLevel: 'time-sensitive',
            contentAvailable: true,
        }));

        expect(result).toEqual([{ status: 'ok', id: 'expo-ticket-0' }]);
        const [call] = providers.expoCalls();
        expect(call!.url).toBe('https://exp.host/--/api/v2/push/send');
        expect(call!.headers.authorization).toBeUndefined();
        expect(JSON.parse(call!.body)).toEqual([{
            to: EXPO_TOKEN,
            priority: 'high',
            title: "It's ready!",
            subtitle: 'happy',
            body: 'Claude finished',
            data: { sessionId: 'sess_1' },
            sound: 'default',
            badge: 2,
            channelId: 'messages',
            categoryId: 'session',
            ttl: 60,
            mutableContent: true,
            interruptionLevel: 'time-sensitive',
            _contentAvailable: true,
        }]);
        expect(deviceRow(h, token)!.last_sent_at).toBe(Date.now());
    });

    it('keeps ticket order across providers and sends every Expo recipient in one request', async () => {
        const h = configured();
        const providers = mockProviders({
            apns: () => new Response(null, { status: 200 }),
            oauth: () => oauthOk(),
            fcm: () => json({ name: 'projects/happy-test/messages/1' }),
            expo: expoOk,
        });
        const expoA = await h.register(expoDevice());
        const ios = await h.register(iosDevice());
        const expoB = await h.register(expoDevice({ deviceId: 'expo-device-0002', platform: 'android', pushToken: EXPO_TOKEN_2 }));
        const android = await h.register(androidDevice());

        const result = await tickets(await h.send([
            { to: [expoA, ios], title: 'one' },
            { to: 'HappyPushToken[0123456789ABCDEFGHIJKL]', title: 'two' },
            { to: [android, expoB], title: 'three' },
        ]));

        expect(result.map((t) => t.status === 'ok' ? t.id!.startsWith('expo-') ? 'expo-ok' : 'ok' : t.details?.error)).toEqual([
            'expo-ok', 'ok', 'DeviceNotRegistered', 'ok', 'expo-ok',
        ]);
        expect(providers.expoCalls()).toHaveLength(1);
        const batch = JSON.parse(providers.expoCalls()[0]!.body) as Array<{ to: string; title: string }>;
        expect(batch.map((m) => [m.to, m.title])).toEqual([[EXPO_TOKEN, 'one'], [EXPO_TOKEN_2, 'three']]);
        expect(result[0]!.id).toBe('expo-ticket-0');
        expect(result[4]!.id).toBe('expo-ticket-1');
    });

    it('sends one Expo request per app id', async () => {
        const h = createHarness();
        const providers = mockProviders({ expo: expoOk });
        const a = await h.register(expoDevice());
        const b = await h.register(expoDevice({ appId: 'com.slopus.happy.preview', pushToken: EXPO_TOKEN_2 }));
        const result = await tickets(await h.send({ to: [a, b], title: 'hi' }));
        expect(result.every((t) => t.status === 'ok')).toBe(true);
        expect(providers.expoCalls()).toHaveLength(2);
    });

    it('deactivates the install on DeviceNotRegistered and passes other Expo errors through', async () => {
        const h = createHarness();
        mockProviders({
            expo: () => json({ data: [
                { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered', expoPushToken: EXPO_TOKEN } },
                { status: 'error', message: 'slow down', details: { error: 'MessageRateExceeded' } },
                { status: 'error', message: 'something new', details: { error: 'SomethingNew' } },
            ] }),
        });
        const dead = await h.register(expoDevice());
        const throttled = await h.register(expoDevice({ deviceId: 'expo-device-0002', pushToken: EXPO_TOKEN_2 }));
        const other = await h.register(expoDevice({ deviceId: 'expo-device-0003', pushToken: 'ExponentPushToken[wwwwwwwwwwwwwwwwwwwwww]' }));

        const result = await tickets(await h.send({ to: [dead, throttled, other], title: 'hi' }));

        expect(result[0]).toMatchObject({ status: 'error', details: { error: 'DeviceNotRegistered', provider: 'expo', reason: 'DeviceNotRegistered' } });
        expect(result[1]).toMatchObject({ status: 'error', details: { error: 'MessageRateExceeded', provider: 'expo' } });
        expect(result[2]).toMatchObject({ status: 'error', details: { provider: 'expo', reason: 'SomethingNew' } });
        expect(result[2]!.details!.error).toBeUndefined();
        expect(deviceRow(h, dead)).toMatchObject({ active: 0, inactive_reason: 'expo:DeviceNotRegistered' });
        expect(deviceRow(h, throttled)).toMatchObject({ active: 1, last_error: 'expo:MessageRateExceeded' });
        expect(deviceRow(h, other)).toMatchObject({ active: 1 });
    });

    it.each([
        ['HTTP 500', () => json({ errors: [{ code: 'INTERNAL_SERVER_ERROR', message: 'boom' }] }, 500), 'INTERNAL_SERVER_ERROR', undefined],
        ['HTTP 429', () => json({ errors: [{ code: 'TOO_MANY_REQUESTS', message: 'slow' }] }, 429), 'TOO_MANY_REQUESTS', 'MessageRateExceeded'],
        ['a non-JSON body', () => new Response('<html>', { status: 502 }), 'HTTP 502', undefined],
        ['a ticket count mismatch', () => json({ data: [] }), 'HTTP 200', undefined],
        ['a network error', () => { throw new TypeError('fetch failed'); }, 'NetworkError', undefined],
    ])('fails every Expo recipient without deactivating on %s', async (_name, expo, reason, error) => {
        const h = createHarness();
        mockProviders({ expo });
        const a = await h.register(expoDevice());
        const b = await h.register(expoDevice({ deviceId: 'expo-device-0002', pushToken: EXPO_TOKEN_2 }));
        const result = await tickets(await h.send({ to: [a, b], title: 'hi' }));
        for (const ticket of result) {
            expect(ticket).toMatchObject({ status: 'error', details: { provider: 'expo', reason } });
            expect(ticket.details!.error).toBe(error);
        }
        expect(deviceRow(h, a)).toMatchObject({ active: 1 });
        expect(deviceRow(h, b)).toMatchObject({ active: 1 });
    });

    it('applies the per-recipient rate limit before forwarding', async () => {
        const limiter = fakeRateLimiter(1);
        const h = createHarness({ SEND_RATE_LIMITER: limiter });
        const providers = mockProviders({ expo: expoOk });
        const token = await h.register(expoDevice());
        const result = await tickets(await h.send({ to: [token, token], title: 'hi' }));
        expect(result.map((t) => t.status === 'ok' ? 'ok' : t.details?.error)).toEqual(['ok', 'MessageRateExceeded']);
        expect(JSON.parse(providers.expoCalls()[0]!.body)).toHaveLength(1);
    });

    it('still answers a raw Expo token with DeviceNotRegistered without calling Expo', async () => {
        const h = createHarness();
        const providers = mockProviders({ expo: expoOk });
        await h.register(expoDevice());
        const [ticket] = await tickets(await h.send({ to: EXPO_TOKEN, title: 'hi' }));
        expect(ticket).toMatchObject({ status: 'error', details: { error: 'DeviceNotRegistered' } });
        expect(providers.calls).toHaveLength(0);
    });
});
