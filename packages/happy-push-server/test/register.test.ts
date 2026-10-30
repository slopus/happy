import { describe, expect, it } from 'vitest';
import { APP_ID, EXPO_TOKEN, FCM_TOKEN, IOS_TOKEN, androidDevice, createHarness, deviceRow, expoDevice, fakeRateLimiter, iosDevice, postJson } from './helpers';

const TOKEN_PATTERN = /^HappyPushToken\[[0-9A-Za-z]{22}\]$/;

describe('POST /v1/devices/register', () => {
    it('mints a HappyPushToken and stores the install', async () => {
        const h = createHarness();
        const token = await h.register(iosDevice({
            environment: 'development',
            metadata: { deviceName: 'Steve’s iPhone', osVersion: '26.1', appVersion: '1.9.0' },
        }));

        expect(token).toMatch(TOKEN_PATTERN);
        const row = deviceRow(h, token)!;
        expect(row).toMatchObject({
            app_id: APP_ID,
            device_id: 'ios-device-0001',
            platform: 'ios',
            environment: 'development',
            push_token: IOS_TOKEN,
            active: 1,
        });
        expect(JSON.parse(row.metadata as string)).toEqual({ deviceName: 'Steve’s iPhone', osVersion: '26.1', appVersion: '1.9.0' });
    });

    it('returns the same token when re-registering with the same native token', async () => {
        const h = createHarness();
        const first = await h.register(iosDevice());
        const second = await h.register(iosDevice());
        expect(second).toBe(first);
        expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM devices').get()).toEqual({ n: 1 });
    });

    it('keeps the token stable across native token rotation and updates the row', async () => {
        const h = createHarness();
        const first = await h.register(iosDevice());
        const rotated = 'b'.repeat(64);
        const second = await h.register(iosDevice({ pushToken: rotated }));
        expect(second).toBe(first);
        expect(deviceRow(h, first)!.push_token).toBe(rotated);
    });

    it('keeps the token stable after unregister and reactivates on re-register', async () => {
        const h = createHarness();
        const first = await h.register(iosDevice());

        const response = await postJson(h.request, '/v1/devices/unregister', { deviceId: 'ios-device-0001', appId: APP_ID });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
        expect(deviceRow(h, first)).toMatchObject({ active: 0, inactive_reason: 'unregistered' });

        const second = await h.register(iosDevice());
        expect(second).toBe(first);
        expect(deviceRow(h, first)).toMatchObject({ active: 1, inactive_reason: null });
    });

    it('updates metadata when provided and keeps it when omitted', async () => {
        const h = createHarness();
        const token = await h.register(androidDevice({ metadata: { appVersion: '1.0.0' } }));
        await h.register(androidDevice({ metadata: { appVersion: '1.1.0', locale: 'en-US' } }));
        expect(JSON.parse(deviceRow(h, token)!.metadata as string)).toEqual({ appVersion: '1.1.0', locale: 'en-US' });
        await h.register(androidDevice());
        expect(JSON.parse(deviceRow(h, token)!.metadata as string)).toEqual({ appVersion: '1.1.0', locale: 'en-US' });
    });

    it('mints distinct tokens per device id and per app id', async () => {
        const h = createHarness();
        const a = await h.register(iosDevice());
        const b = await h.register(iosDevice({ deviceId: 'ios-device-0002', pushToken: 'c'.repeat(64) }));
        const c = await h.register(iosDevice({ appId: 'com.slopus.happy.preview' }));
        expect(new Set([a, b, c]).size).toBe(3);
    });

    it('moves a native token to the newest device id so it is never delivered twice', async () => {
        const h = createHarness();
        const oldToken = await h.register(iosDevice({ deviceId: 'install-before-reinstall' }));
        const newToken = await h.register(iosDevice({ deviceId: 'install-after-reinstall' }));

        expect(newToken).not.toBe(oldToken);
        expect(deviceRow(h, oldToken)).toMatchObject({ active: 0, inactive_reason: 'superseded' });
        expect(deviceRow(h, newToken)).toMatchObject({ active: 1 });

        // And it can move back if the old install re-registers it.
        await h.register(iosDevice({ deviceId: 'install-before-reinstall' }));
        expect(deviceRow(h, oldToken)).toMatchObject({ active: 1 });
        expect(deviceRow(h, newToken)).toMatchObject({ active: 0, inactive_reason: 'superseded' });
    });

    it('treats device ids case-insensitively', async () => {
        const h = createHarness();
        const upper = await h.register(iosDevice({ deviceId: 'E621E1F8-C36C-495A-93FC-0C247A3E6E5F' }));
        const lower = await h.register(iosDevice({ deviceId: 'e621e1f8-c36c-495a-93fc-0c247a3e6e5f' }));
        expect(lower).toBe(upper);
        expect(deviceRow(h, upper)!.device_id).toBe('e621e1f8-c36c-495a-93fc-0c247a3e6e5f');
    });

    it('normalizes APNs tokens to lowercase', async () => {
        const h = createHarness();
        const token = await h.register(iosDevice({ pushToken: 'ABCDEF'.repeat(10) + 'ABCD' }));
        expect(deviceRow(h, token)!.push_token).toBe('abcdef'.repeat(10) + 'abcd');
    });

    it('stores android installs as production regardless of environment', async () => {
        const h = createHarness();
        const token = await h.register(androidDevice({ environment: 'development' }));
        expect(deviceRow(h, token)).toMatchObject({ platform: 'android', environment: 'production' });
    });

    it.each([
        ['missing deviceId', { appId: APP_ID, platform: 'ios', pushToken: IOS_TOKEN }, 'deviceId'],
        ['short deviceId', iosDevice({ deviceId: 'short' }), 'deviceId'],
        ['long deviceId', iosDevice({ deviceId: 'x'.repeat(129) }), 'deviceId'],
        ['bad appId', iosDevice({ appId: 'com.happy/../evil' }), 'appId'],
        ['unknown platform', iosDevice({ platform: 'web' }), 'platform'],
        ['non-hex APNs token', iosDevice({ pushToken: 'z'.repeat(64) }), 'pushToken'],
        ['short APNs token', iosDevice({ pushToken: 'a'.repeat(32) }), 'pushToken'],
        ['FCM token with spaces', androidDevice({ pushToken: 'bad token '.repeat(10) }), 'pushToken'],
        ['bad environment', iosDevice({ environment: 'staging' }), 'environment'],
        ['metadata too long', iosDevice({ metadata: { deviceName: 'x'.repeat(129) } }), 'metadata.deviceName'],
    ])('rejects %s', async (_name, body, path) => {
        const h = createHarness();
        const response = await postJson(h.request, '/v1/devices/register', body);
        expect(response.status).toBe(400);
        const json = await response.json() as { errors: Array<{ code: string; details: Array<{ path: string }> }> };
        expect(json.errors[0]!.code).toBe('VALIDATION_ERROR');
        expect(json.errors[0]!.details.map((d) => d.path)).toContain(path);
        expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM devices').get()).toEqual({ n: 0 });
    });

    it('rejects a body that is not JSON', async () => {
        const h = createHarness();
        const response = await postJson(h.request, '/v1/devices/register', '{not json');
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ errors: [{ code: 'VALIDATION_ERROR', message: 'Request body must be JSON' }] });
    });

    it('rejects oversized bodies, streamed or with Content-Length', async () => {
        const h = createHarness();
        const body = JSON.stringify(iosDevice({ padding: 'x'.repeat(20_000) }));
        const streamed = await postJson(h.request, '/v1/devices/register', body);
        expect(streamed.status).toBe(413);
        expect(await streamed.json()).toMatchObject({ errors: [{ code: 'PAYLOAD_TOO_LARGE' }] });

        const declared = await postJson(h.request, '/v1/devices/register', body, { 'content-length': String(body.length) });
        expect(declared.status).toBe(413);
        expect(await declared.json()).toMatchObject({ errors: [{ code: 'PAYLOAD_TOO_LARGE' }] });
    });

    it('enforces ALLOWED_APP_IDS', async () => {
        const h = createHarness({ ALLOWED_APP_IDS: ' com.ex3ndr.happy , com.slopus.happy.dev ' });
        expect(await h.register(iosDevice({ appId: 'com.slopus.happy.dev' }))).toMatch(TOKEN_PATTERN);
        const response = await postJson(h.request, '/v1/devices/register', iosDevice({ appId: 'com.someone.else' }));
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ errors: [{ code: 'APP_NOT_ALLOWED' }] });
    });

    it('answers unregister for unknown installs the same way', async () => {
        const h = createHarness();
        const response = await postJson(h.request, '/v1/devices/unregister', { deviceId: 'never-registered', appId: APP_ID });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
    });
});

describe('Expo tokens', () => {
    it.each([
        ['ExponentPushToken', EXPO_TOKEN],
        ['ExpoPushToken', 'ExpoPushToken[yyyyyyyyyyyyyyyyyyyyyy]'],
    ])('registers an %s and keeps the device platform', async (_name, pushToken) => {
        const h = createHarness();
        const token = await h.register(expoDevice({ platform: 'android', pushToken, environment: 'development' }));
        expect(token).toMatch(TOKEN_PATTERN);
        // environment is APNs-only, so it is ignored for Expo installs.
        expect(deviceRow(h, token)).toMatchObject({ platform: 'android', provider: 'expo', environment: 'production', push_token: pushToken, active: 1 });
    });

    it('keeps the same token when an install moves from Expo to a native token', async () => {
        const h = createHarness();
        const expo = await h.register(expoDevice({ deviceId: 'ios-device-0001' }));
        const native = await h.register(iosDevice());
        expect(native).toBe(expo);
        expect(deviceRow(h, expo)).toMatchObject({ provider: 'apns', push_token: IOS_TOKEN, active: 1 });
    });

    it('keeps the same token when an install moves from a native token back to Expo', async () => {
        const h = createHarness();
        const native = await h.register(androidDevice());
        const expo = await h.register(expoDevice({ deviceId: 'android-device-0001', platform: 'android' }));
        expect(expo).toBe(native);
        expect(deviceRow(h, native)).toMatchObject({ provider: 'expo', push_token: EXPO_TOKEN, platform: 'android' });
    });

    it('moves an Expo token to the newest device id', async () => {
        const h = createHarness();
        const before = await h.register(expoDevice({ deviceId: 'install-before-reinstall' }));
        const after = await h.register(expoDevice({ deviceId: 'install-after-reinstall' }));
        expect(after).not.toBe(before);
        expect(deviceRow(h, before)).toMatchObject({ active: 0, inactive_reason: 'superseded' });
        expect(deviceRow(h, after)).toMatchObject({ active: 1 });
    });

    it('does not let an Expo token supersede a native install, or the reverse', async () => {
        const h = createHarness();
        const native = await h.register(androidDevice({ deviceId: 'android-device-0001' }));
        await h.register(expoDevice({ deviceId: 'expo-device-0002', platform: 'android' }));
        expect(deviceRow(h, native)).toMatchObject({ active: 1 });
    });

    it.each([
        ['an Expo token as an APNs token', iosDevice({ pushToken: EXPO_TOKEN }), 'pushToken'],
        ['a native token as an Expo token', expoDevice({ pushToken: IOS_TOKEN }), 'pushToken'],
        ['an Expo token without brackets', expoDevice({ pushToken: 'ExponentPushToken' }), 'pushToken'],
        ['an Expo token with bad characters', expoDevice({ pushToken: 'ExponentPushToken[a b]' }), 'pushToken'],
        ['an over-long Expo token', expoDevice({ pushToken: `ExponentPushToken[${'x'.repeat(201)}]` }), 'pushToken'],
        ['apns for android', androidDevice({ provider: 'apns' }), 'provider'],
        ['fcm for ios', iosDevice({ provider: 'fcm' }), 'provider'],
        ['an unknown provider', iosDevice({ provider: 'webpush' }), 'provider'],
    ])('rejects %s', async (_name, body, path) => {
        const h = createHarness();
        const response = await postJson(h.request, '/v1/devices/register', body);
        expect(response.status).toBe(400);
        const json = await response.json() as { errors: Array<{ details: Array<{ path: string }> }> };
        expect(json.errors[0]!.details.map((d) => d.path)).toContain(path);
    });

    it('accepts an explicit native provider', async () => {
        const h = createHarness();
        const token = await h.register(androidDevice({ provider: 'fcm' }));
        expect(deviceRow(h, token)).toMatchObject({ provider: 'fcm', push_token: FCM_TOKEN });
    });
});

describe('nativeToken alias', () => {
    it('still accepts the original nativeToken field', async () => {
        const h = createHarness();
        const { pushToken, ...rest } = iosDevice();
        const token = await h.register({ ...rest, nativeToken: pushToken });
        expect(deviceRow(h, token)).toMatchObject({ provider: 'apns', push_token: IOS_TOKEN });
    });
});

describe('registration rate limiting', () => {
    it('limits register and unregister per client IP with a 429', async () => {
        const limiter = fakeRateLimiter(2);
        const h = createHarness({ REGISTER_RATE_LIMITER: limiter });
        const fromIp = (ip: string) => ({ 'cf-connecting-ip': ip });

        expect((await postJson(h.request, '/v1/devices/register', iosDevice(), fromIp('203.0.113.7'))).status).toBe(200);
        expect((await postJson(h.request, '/v1/devices/unregister', { deviceId: 'ios-device-0001', appId: APP_ID }, fromIp('203.0.113.7'))).status).toBe(200);
        const limited = await postJson(h.request, '/v1/devices/register', iosDevice(), fromIp('203.0.113.7'));
        expect(limited.status).toBe(429);
        expect(await limited.json()).toMatchObject({ errors: [{ code: 'RATE_LIMITED' }] });

        // Another IP has its own budget.
        expect((await postJson(h.request, '/v1/devices/register', iosDevice(), fromIp('198.51.100.1'))).status).toBe(200);
        expect(limiter.keys).toEqual(['register:203.0.113.7', 'register:203.0.113.7', 'register:203.0.113.7', 'register:198.51.100.1']);
    });

    it('rejects over-limit requests before reading the body', async () => {
        const h = createHarness({ REGISTER_RATE_LIMITER: fakeRateLimiter(0) });
        const response = await postJson(h.request, '/v1/devices/register', '{not json');
        expect(response.status).toBe(429);
    });
});

describe('misc routes', () => {
    it('serves /health', async () => {
        const h = createHarness();
        const response = await h.request('/health');
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
    });

    it('answers unknown routes with an Expo-style error', async () => {
        const h = createHarness();
        const response = await h.request('/v2/nope');
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ errors: [{ code: 'NOT_FOUND', message: 'Not found' }] });
    });
});
