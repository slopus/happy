/**
 * APNs over the HTTP/2 provider API with token-based (.p8) auth.
 *
 * `data` goes where Expo's push service puts it, because that is what
 * expo-notifications parses: on iOS it exposes `request.content.data` as the
 * payload's top-level `body` dictionary (NotificationRecords.swift,
 * serializedNotificationData). Putting `data` anywhere else would break the
 * app's notification-tap routing, which reads `data.sessionId`.
 */

import type { Env } from '@/env';
import { importPkcs8Key, signJwt } from '@/providers/jwt';
import { fetchFailureReason, providerFailure, type ProviderResult } from '@/providers/types';
import { hasVisibleAlert, resolvePriority, type PushMessage } from '@/schema';
import type { DeviceRecord } from '@/storage/devices';
import { utf8Length } from '@/utils/encoding';

const PRODUCTION_HOST = 'https://api.push.apple.com';
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';
const MAX_PAYLOAD_BYTES = 4096;
/**
 * Apple accepts provider tokens for up to an hour and rejects refreshing more
 * than once every 20 minutes (TooManyProviderTokenUpdates).
 */
const JWT_REFRESH_MS = 50 * 60 * 1000;

export interface ApnsConfig {
    keyId: string;
    teamId: string;
    privateKey: string;
}

export function readApnsConfig(env: Env): ApnsConfig | null {
    if (!env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_PRIVATE_KEY) {
        return null;
    }
    return { keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, privateKey: env.APNS_PRIVATE_KEY };
}

// Only settled values are cached across requests. Sharing an in-flight promise
// between requests is unsafe in Workers, so callers dedupe within a request.
const jwtCache = new Map<string, { token: string; issuedAt: number }>();

export async function getApnsJwt(config: ApnsConfig, now: number): Promise<string> {
    const cacheKey = `${config.teamId}:${config.keyId}`;
    const cached = jwtCache.get(cacheKey);
    if (cached && now - cached.issuedAt < JWT_REFRESH_MS) {
        return cached.token;
    }
    const key = await importPkcs8Key(config.privateKey, 'ES256');
    const token = await signJwt('ES256', key, { kid: config.keyId }, {
        iss: config.teamId,
        iat: Math.floor(now / 1000),
    });
    jwtCache.set(cacheKey, { token, issuedAt: now });
    return token;
}

/** Drops a cached token Apple has rejected, so the next request signs a fresh one. */
export function invalidateApnsJwt(config: ApnsConfig, token: string): void {
    const cacheKey = `${config.teamId}:${config.keyId}`;
    if (jwtCache.get(cacheKey)?.token === token) {
        jwtCache.delete(cacheKey);
    }
}

export function resetApnsCache(): void {
    jwtCache.clear();
}

export interface ApnsRequest {
    headers: Record<string, string>;
    payload: Record<string, unknown>;
}

export function buildApnsRequest(message: PushMessage, device: DeviceRecord, now: number): ApnsRequest {
    const hasAlert = hasVisibleAlert(message);
    const aps: Record<string, unknown> = {};
    if (hasAlert) {
        const alert: Record<string, string> = {};
        if (message.title) alert.title = message.title;
        if (message.subtitle) alert.subtitle = message.subtitle;
        if (message.body) alert.body = message.body;
        aps.alert = alert;
    }
    if (typeof message.sound === 'string') aps.sound = message.sound;
    if (message.badge !== undefined) aps.badge = message.badge;
    if (message.threadId) aps['thread-id'] = message.threadId;
    if (message.categoryId) aps.category = message.categoryId;
    if (message.mutableContent) aps['mutable-content'] = 1;
    if (message.interruptionLevel) aps['interruption-level'] = message.interruptionLevel;
    if (!hasAlert || message.contentAvailable) aps['content-available'] = 1;

    const isBackground = !hasAlert;
    const headers: Record<string, string> = {
        'apns-topic': device.appId,
        'apns-push-type': isBackground ? 'background' : 'alert',
        // Apple requires priority 5 for background pushes, whatever was asked.
        'apns-priority': isBackground || resolvePriority(message) === 'normal' ? '5' : '10',
        'content-type': 'application/json',
    };
    if (message.ttl !== undefined) {
        // An expiration of 0 tells APNs to try once and not store the push.
        headers['apns-expiration'] = String(message.ttl === 0 ? 0 : Math.floor(now / 1000) + message.ttl);
    }

    return { headers, payload: { aps, body: message.data ?? {} } };
}

export async function sendApns(params: {
    config: ApnsConfig;
    jwt: string;
    device: DeviceRecord;
    message: PushMessage;
    apnsId: string;
    now: number;
    signal: AbortSignal;
}): Promise<ProviderResult> {
    const { headers, payload } = buildApnsRequest(params.message, params.device, params.now);
    const body = JSON.stringify(payload);
    if (utf8Length(body) > MAX_PAYLOAD_BYTES) {
        return providerFailure('apns', 'PayloadTooLarge', { error: 'MessageTooBig' });
    }

    const host = params.device.environment === 'development' ? SANDBOX_HOST : PRODUCTION_HOST;
    let response: Response;
    try {
        response = await fetch(`${host}/3/device/${params.device.pushToken}`, {
            method: 'POST',
            headers: { ...headers, authorization: `bearer ${params.jwt}`, 'apns-id': params.apnsId },
            body,
            signal: params.signal,
        });
    } catch (error) {
        return providerFailure('apns', fetchFailureReason(error));
    }

    if (response.status === 200) {
        await response.body?.cancel();
        return { ok: true };
    }

    const reason = await readApnsReason(response);
    const result = classifyApnsError(response.status, reason);
    if (result.ok === false && result.error === 'InvalidCredentials') {
        invalidateApnsJwt(params.config, params.jwt);
    }
    return result;
}

async function readApnsReason(response: Response): Promise<string> {
    try {
        const json = await response.json() as { reason?: unknown };
        return typeof json.reason === 'string' ? json.reason : `HTTP ${response.status}`;
    } catch {
        return `HTTP ${response.status}`;
    }
}

// DeviceTokenNotForTopic: the token belongs to a different bundle id than the
// one this install registered, so it can never be delivered here.
const UNREGISTERED_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'ExpiredToken', 'DeviceTokenNotForTopic']);
const CREDENTIAL_REASONS = new Set(['InvalidProviderToken', 'ExpiredProviderToken', 'MissingProviderToken', 'BadCertificate', 'BadCertificateEnvironment', 'Forbidden']);

// https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns
export function classifyApnsError(status: number, reason: string): ProviderResult {
    const httpStatus = status;
    if (status === 410 || UNREGISTERED_REASONS.has(reason)) {
        return providerFailure('apns', reason, { error: 'DeviceNotRegistered', unregistered: true, httpStatus });
    }
    if (CREDENTIAL_REASONS.has(reason)) {
        return providerFailure('apns', reason, { error: 'InvalidCredentials', httpStatus });
    }
    if (status === 413 || reason === 'PayloadTooLarge') {
        return providerFailure('apns', reason, { error: 'MessageTooBig', httpStatus });
    }
    if (status === 429) {
        return providerFailure('apns', reason, { error: 'MessageRateExceeded', httpStatus });
    }
    return providerFailure('apns', reason, { httpStatus });
}
