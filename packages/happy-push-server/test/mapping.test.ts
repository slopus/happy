import { describe, expect, it } from 'vitest';
import { buildApnsRequest } from '@/providers/apns';
import { buildExpoMessage, classifyExpoTicket } from '@/providers/expo';
import { buildFcmMessage } from '@/providers/fcm';
import type { DeviceRecord } from '@/storage/devices';
import { formatPushToken, mintDeviceId, parsePushToken } from '@/token';

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const NOW_SECONDS = Math.floor(NOW / 1000);

const ios: DeviceRecord = { id: 'x', appId: 'com.ex3ndr.happy', platform: 'ios', provider: 'apns', environment: 'production', pushToken: 'a'.repeat(64), active: true };
const android: DeviceRecord = { ...ios, platform: 'android', provider: 'fcm', pushToken: 'fcm-token' };

describe('HappyPushToken tokens', () => {
    it('mints 22-char base62 ids that round-trip through the token format', () => {
        const ids = new Set(Array.from({ length: 1000 }, mintDeviceId));
        expect(ids.size).toBe(1000);
        for (const id of ids) {
            expect(id).toMatch(/^[0-9A-Za-z]{22}$/);
            expect(parsePushToken(formatPushToken(id))).toBe(id);
        }
    });

    it.each(['ExponentPushToken[abc]', 'HappyPushToken[]', 'HappyPushToken[short]', 'HappyPushToken[0123456789ABCDEFGHIJK!]', 'HappyPushToken[0123456789ABCDEFGHIJKL', 'happypushtoken[0123456789ABCDEFGHIJKL]', 'HPPY-0123456789ABCDEFGHIJKL', ' HappyPushToken[0123456789ABCDEFGHIJKL]', ''])(
        'rejects %j', (token) => {
            expect(parsePushToken(token)).toBeNull();
        }
    );
});

describe('buildApnsRequest', () => {
    it('defaults data to an empty body and omits unset aps fields', () => {
        const { headers, payload } = buildApnsRequest({ to: 'x', body: 'hello' }, ios, NOW);
        expect(payload).toEqual({ aps: { alert: { body: 'hello' } }, body: {} });
        expect(headers).toEqual({
            'apns-topic': 'com.ex3ndr.happy',
            'apns-push-type': 'alert',
            'apns-priority': '10',
            'content-type': 'application/json',
        });
    });

    it.each([
        ['alert, default', { title: 't' }, 'alert', '10'],
        ['alert, high', { title: 't', priority: 'high' }, 'alert', '10'],
        ['alert, normal', { title: 't', priority: 'normal' }, 'alert', '5'],
        ['background, default', { data: { a: 1 } }, 'background', '5'],
        // Apple requires 5 for background pushes, so 'high' cannot raise it.
        ['background, high', { data: { a: 1 }, priority: 'high' }, 'background', '5'],
    ] as const)('maps priority for %s', (_name, fields, pushType, priority) => {
        const { headers } = buildApnsRequest({ to: 'x', ...fields }, ios, NOW);
        expect(headers['apns-push-type']).toBe(pushType);
        expect(headers['apns-priority']).toBe(priority);
    });

    it('adds content-available on alerts when contentAvailable is set', () => {
        const { payload } = buildApnsRequest({ to: 'x', title: 't', contentAvailable: true }, ios, NOW);
        expect(payload.aps).toEqual({ alert: { title: 't' }, 'content-available': 1 });
    });

    it('omits sound when null and maps interruption level', () => {
        const { payload } = buildApnsRequest({ to: 'x', title: 't', sound: null, interruptionLevel: 'time-sensitive' }, ios, NOW);
        expect(payload.aps).toEqual({ alert: { title: 't' }, 'interruption-level': 'time-sensitive' });
    });

    it.each([
        [{ ttl: 30 }, String(NOW_SECONDS + 30)],
        [{ ttl: 0 }, '0'],
        [{}, undefined],
    ])('derives apns-expiration from %j', (fields, expected) => {
        expect(buildApnsRequest({ to: 'x', title: 't', ...fields }, ios, NOW).headers['apns-expiration']).toBe(expected);
    });
});

describe('buildFcmMessage', () => {
    type Built = { message: { data: Record<string, string>; android: { priority: string; ttl?: string } } };

    it('always sends a JSON body and only string data values', () => {
        const message = buildFcmMessage({ to: 'x', data: { n: 1, flag: true, nested: { a: [1] } } }, android) as Built;
        expect(message.message.data).toEqual({ body: '{"n":1,"flag":true,"nested":{"a":[1]}}' });
        expect(Object.values(message.message.data).every((v) => typeof v === 'string')).toBe(true);
    });

    it.each([
        ['alert, default', { title: 't' }, 'HIGH'],
        ['alert, normal', { title: 't', priority: 'normal' }, 'NORMAL'],
        ['data-only, default', { data: { a: 1 } }, 'NORMAL'],
        ['data-only, high', { data: { a: 1 }, priority: 'high' }, 'HIGH'],
    ] as const)('maps priority for %s', (_name, fields, expected) => {
        expect((buildFcmMessage({ to: 'x', ...fields }, android) as Built).message.android.priority).toBe(expected);
    });

    it('maps custom sounds, subtitle and category', () => {
        const message = buildFcmMessage({ to: 'x', title: 't', subtitle: 's', sound: 'chime.wav', categoryId: 'c' }, android) as Built;
        expect(message.message.data).toEqual({ title: 't', subtitle: 's', body: '{}', sound: 'chime.wav', categoryId: 'c' });
    });

    it('maps ttl to android.ttl', () => {
        expect((buildFcmMessage({ to: 'x', title: 't', ttl: 45 }, android) as Built).message.android.ttl).toBe('45s');
        expect((buildFcmMessage({ to: 'x', title: 't' }, android) as Built).message.android.ttl).toBeUndefined();
    });
});

describe('buildExpoMessage', () => {
    const expo: DeviceRecord = { ...ios, provider: 'expo', pushToken: 'ExponentPushToken[abc]' };

    it.each([
        ['an alert', { title: 't' }, { to: 'ExponentPushToken[abc]', priority: 'high', title: 't' }],
        ['a data-only push', { data: { a: 1 } }, { to: 'ExponentPushToken[abc]', priority: 'normal', data: { a: 1 } }],
        ['an explicit priority', { title: 't', priority: 'normal' }, { to: 'ExponentPushToken[abc]', priority: 'normal', title: 't' }],
        ['a silent alert', { title: 't', sound: null }, { to: 'ExponentPushToken[abc]', priority: 'high', title: 't', sound: null }],
        ['threadId, which Expo has no field for', { title: 't', threadId: 'x' }, { to: 'ExponentPushToken[abc]', priority: 'high', title: 't' }],
    ] as const)('maps %s', (_name, fields, expected) => {
        expect(buildExpoMessage({ to: 'x', ...fields }, expo)).toEqual(expected);
    });
});

describe('classifyExpoTicket', () => {
    it.each([
        [{ status: 'ok', id: 'r1' }, { ok: true, id: 'r1' }],
        [{ status: 'error', message: 'm', details: { error: 'DeviceNotRegistered' } }, { ok: false, error: 'DeviceNotRegistered', unregistered: true, reason: 'DeviceNotRegistered' }],
        [{ status: 'error', message: 'm', details: { error: 'InvalidCredentials' } }, { ok: false, error: 'InvalidCredentials', unregistered: false }],
        [{ status: 'error', message: 'free text' }, { ok: false, error: undefined, unregistered: false, reason: 'free text' }],
        [null, { ok: false, error: undefined, unregistered: false, reason: 'UnknownError' }],
    ])('classifies %j', (ticket, expected) => {
        expect(classifyExpoTicket(ticket)).toMatchObject(expected);
    });
});
