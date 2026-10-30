/**
 * Forwarding to Expo's push service, for installs that registered an Expo
 * push token instead of a native one. No Expo access token is sent, which is
 * Expo's default for projects that do not enforce push security.
 *
 * Only tickets are read. Expo queues messages and reports final delivery
 * (including some DeviceNotRegistered cases) through its receipts API, which
 * this server does not poll, the same as happy-server before it.
 */

import { fetchFailureReason, providerFailure, type ProviderFailure, type PushErrorCode } from '@/providers/types';
import { resolvePriority, type PushMessage } from '@/schema';
import type { DeviceRecord } from '@/storage/devices';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** Expo's documented maximum messages per request. */
export const EXPO_BATCH_SIZE = 100;

const EXPO_ERROR_CODES = new Set<PushErrorCode>([
    'DeviceNotRegistered',
    'InvalidCredentials',
    'MessageTooBig',
    'MessageRateExceeded',
    'MismatchSenderId',
]);

export type ExpoResult = { ok: true; id: string } | ProviderFailure;

export interface ExpoRecipient {
    device: DeviceRecord;
    message: PushMessage;
}

export function buildExpoMessage(message: PushMessage, device: DeviceRecord): Record<string, unknown> {
    const expo: Record<string, unknown> = {
        to: device.pushToken,
        priority: resolvePriority(message),
    };
    if (message.title !== undefined) expo.title = message.title;
    if (message.subtitle !== undefined) expo.subtitle = message.subtitle;
    if (message.body !== undefined) expo.body = message.body;
    if (message.data !== undefined) expo.data = message.data;
    if (message.sound !== undefined) expo.sound = message.sound;
    if (message.badge !== undefined) expo.badge = message.badge;
    if (message.channelId !== undefined) expo.channelId = message.channelId;
    if (message.categoryId !== undefined) expo.categoryId = message.categoryId;
    if (message.ttl !== undefined) expo.ttl = message.ttl;
    if (message.mutableContent !== undefined) expo.mutableContent = message.mutableContent;
    if (message.interruptionLevel !== undefined) expo.interruptionLevel = message.interruptionLevel;
    if (message.contentAvailable !== undefined) expo._contentAvailable = message.contentAvailable;
    // threadId has no Expo equivalent and is dropped.
    return expo;
}

/** Sends one batch (≤100) in a single request; results are in batch order. */
export async function sendExpoBatch(batch: readonly ExpoRecipient[], signal: AbortSignal): Promise<ExpoResult[]> {
    const failAll = (failure: ProviderFailure) => batch.map(() => failure);

    let response: Response;
    try {
        response = await fetch(EXPO_PUSH_URL, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify(batch.map(({ device, message }) => buildExpoMessage(message, device))),
            signal,
        });
    } catch (error) {
        return failAll(providerFailure('expo', fetchFailureReason(error)));
    }

    let json: { data?: unknown; errors?: Array<{ code?: unknown }> };
    try {
        json = await response.json() as typeof json;
    } catch {
        return failAll(providerFailure('expo', `HTTP ${response.status}`, { httpStatus: response.status }));
    }

    if (!response.ok || !Array.isArray(json.data) || json.data.length !== batch.length) {
        const code = typeof json.errors?.[0]?.code === 'string' ? json.errors[0].code : `HTTP ${response.status}`;
        return failAll(providerFailure('expo', code, {
            error: response.status === 429 ? 'MessageRateExceeded' : undefined,
            httpStatus: response.status,
        }));
    }

    return json.data.map((ticket): ExpoResult => classifyExpoTicket(ticket));
}

export function classifyExpoTicket(ticket: unknown): ExpoResult {
    const t = (ticket ?? {}) as { status?: unknown; id?: unknown; message?: unknown; details?: { error?: unknown } };
    if (t.status === 'ok' && typeof t.id === 'string') {
        return { ok: true, id: t.id };
    }
    const code = typeof t.details?.error === 'string' ? t.details.error : undefined;
    const known = code !== undefined && EXPO_ERROR_CODES.has(code as PushErrorCode) ? code as PushErrorCode : undefined;
    return providerFailure('expo', code ?? (typeof t.message === 'string' ? t.message.slice(0, 200) : 'UnknownError'), {
        error: known,
        unregistered: known === 'DeviceNotRegistered',
    });
}
