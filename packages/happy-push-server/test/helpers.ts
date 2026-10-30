import { vi } from 'vitest';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { parsePushToken } from '@/token';
import { createTestDb, type TestDb } from './d1';

export const APP_ID = 'com.ex3ndr.happy';
export const IOS_TOKEN = 'a'.repeat(64);
export const FCM_TOKEN = 'fcm-token-' + 'x'.repeat(140);

export interface Harness extends TestDb {
    env: Env;
    request(path: string, init?: RequestInit): Promise<Response>;
    register(body: Record<string, unknown>): Promise<string>;
    send(body: unknown): Promise<Response>;
}

export function createHarness(env: Partial<Env> = {}): Harness {
    const testDb = createTestDb();
    const fullEnv: Env = { DB: testDb.db, ...env };
    const app = createApp();
    const request = async (path: string, init?: RequestInit) => app.request(path, init, fullEnv);
    return {
        ...testDb,
        env: fullEnv,
        request,
        register: async (body) => {
            const response = await postJson(request, '/v1/devices/register', body);
            if (response.status !== 200) {
                throw new Error(`register failed: ${response.status} ${await response.text()}`);
            }
            return ((await response.json()) as { token: string }).token;
        },
        send: (body) => postJson(request, '/v1/push/send', body),
    };
}

export function postJson(
    request: Harness['request'],
    path: string,
    body: unknown,
    headers: Record<string, string> = {}
): Promise<Response> {
    return request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

export function iosDevice(overrides: Record<string, unknown> = {}) {
    return { deviceId: 'ios-device-0001', appId: APP_ID, platform: 'ios', pushToken: IOS_TOKEN, ...overrides };
}

export const EXPO_TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

export function expoDevice(overrides: Record<string, unknown> = {}) {
    return { deviceId: 'expo-device-0001', appId: APP_ID, platform: 'ios', provider: 'expo', pushToken: EXPO_TOKEN, ...overrides };
}

/** Answers an Expo send with one ok ticket per message, ids `expo-ticket-<n>`. */
export function expoOk(request: RecordedRequest): Response {
    const messages = JSON.parse(request.body) as unknown[];
    return json({ data: messages.map((_, i) => ({ status: 'ok', id: `expo-ticket-${i}` })) });
}

export function androidDevice(overrides: Record<string, unknown> = {}) {
    return { deviceId: 'android-device-0001', appId: APP_ID, platform: 'android', pushToken: FCM_TOKEN, ...overrides };
}

export function toPem(der: ArrayBuffer, label: string): string {
    const base64 = Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n');
    return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

export async function generateApnsKey() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer;
    return { pem: toPem(pkcs8, 'PRIVATE KEY'), publicKey: pair.publicKey };
}

export async function generateServiceAccount() {
    const pair = await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['sign', 'verify']
    ) as CryptoKeyPair;
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer;
    const account = {
        type: 'service_account',
        project_id: 'happy-test',
        client_email: 'push@happy-test.iam.gserviceaccount.com',
        private_key: toPem(pkcs8, 'PRIVATE KEY'),
        token_uri: 'https://oauth2.googleapis.com/token',
    };
    return { json: JSON.stringify(account), account, publicKey: pair.publicKey };
}

export function decodeJwt(jwt: string) {
    const [header, claims, signature] = jwt.split('.');
    const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return { header: decode(header!), claims: decode(claims!), signature: signature!, signingInput: `${header}.${claims}` };
}

export async function verifyJwt(jwt: string, publicKey: CryptoKey): Promise<boolean> {
    const { signature, signingInput } = decodeJwt(jwt);
    const algorithm = publicKey.algorithm.name === 'ECDSA'
        ? { name: 'ECDSA', hash: 'SHA-256' }
        : { name: 'RSASSA-PKCS1-v1_5' };
    return crypto.subtle.verify(algorithm, publicKey, Buffer.from(signature, 'base64url'), new TextEncoder().encode(signingInput));
}

export interface RecordedRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
}

/**
 * Replaces global fetch with a router over provider URLs. Every call is
 * recorded; anything unrouted fails the test loudly.
 */
export function mockProviders(routes: {
    apns?: (request: RecordedRequest) => Response | Promise<Response>;
    fcm?: (request: RecordedRequest) => Response | Promise<Response>;
    oauth?: (request: RecordedRequest) => Response | Promise<Response>;
    expo?: (request: RecordedRequest) => Response | Promise<Response>;
}) {
    const calls: RecordedRequest[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const recorded: RecordedRequest = {
            url: request.url,
            method: request.method,
            headers: Object.fromEntries(request.headers.entries()),
            body: await request.text(),
        };
        calls.push(recorded);
        const url = new URL(request.url);
        if (url.hostname.endsWith('push.apple.com') && routes.apns) return routes.apns(recorded);
        if (url.hostname === 'fcm.googleapis.com' && routes.fcm) return routes.fcm(recorded);
        if (url.hostname === 'oauth2.googleapis.com' && routes.oauth) return routes.oauth(recorded);
        if (url.hostname === 'exp.host' && routes.expo) return routes.expo(recorded);
        throw new Error(`unexpected fetch to ${request.url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return {
        calls,
        apnsCalls: () => calls.filter((c) => new URL(c.url).hostname.endsWith('push.apple.com')),
        fcmCalls: () => calls.filter((c) => new URL(c.url).hostname === 'fcm.googleapis.com'),
        oauthCalls: () => calls.filter((c) => new URL(c.url).hostname === 'oauth2.googleapis.com'),
        expoCalls: () => calls.filter((c) => new URL(c.url).hostname === 'exp.host'),
    };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function oauthOk(token = 'ya29.test-access-token', expiresIn = 3599): Response {
    return json({ access_token: token, expires_in: expiresIn, token_type: 'Bearer' });
}

export function deviceRow(harness: Harness, token: string) {
    return harness.sqlite.prepare('SELECT * FROM devices WHERE id = ?').get(parsePushToken(token)) as Record<string, unknown> | undefined;
}

/** A RateLimit binding that allows cputime         unlimited
filesize        unlimited
datasize        unlimited
stacksize       7MB
coredumpsize    0kB
addressspace    unlimited
memorylocked    unlimited
maxproc         10666
descriptors     1048576 calls per key, recording every key asked. */
export function fakeRateLimiter(limit: number): RateLimit & { keys: string[] } {
    const counts = new Map<string, number>();
    const keys: string[] = [];
    return {
        keys,
        limit: async ({ key }) => {
            keys.push(key);
            const count = (counts.get(key) ?? 0) + 1;
            counts.set(key, count);
            return { success: count <= limit };
        },
    };
}
