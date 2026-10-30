/**
 * Fans messages out to APNs/FCM and answers with one ticket per recipient,
 * in request order. Ticket shape and error codes follow Expo's, so a sender's
 * existing `DeviceNotRegistered` cleanup keeps working.
 *
 * Delivery is synchronous: both providers accept or reject a message in the
 * same HTTP exchange, so a ticket is final and there is no receipts API.
 */

import type { Env } from '@/env';
import { getApnsJwt, readApnsConfig, sendApns, type ApnsConfig } from '@/providers/apns';
import { EXPO_BATCH_SIZE, sendExpoBatch, type ExpoResult } from '@/providers/expo';
import { FcmAuthError, FcmConfigError, getFcmAccessToken, readFcmConfig, sendFcm, type FcmConfig } from '@/providers/fcm';
import { fetchFailureReason, providerFailure, type ProviderFailure, type ProviderName, type ProviderResult, type PushErrorCode } from '@/providers/types';
import type { PushMessage } from '@/schema';
import { findDevices, recordDeliveries, type DeliveryRecord, type DeviceRecord } from '@/storage/devices';
import { formatPushToken, parsePushToken } from '@/token';
import { mapWithConcurrency } from '@/utils/concurrency';
import { isWithinLimit } from '@/utils/rateLimit';
import { redactToken } from '@/utils/redact';

/**
 * Workers allow 6 simultaneous outbound connections per request and queue
 * the rest, so more in flight would only add queueing, not throughput.
 */
const SEND_CONCURRENCY = 6;
/** happy-server gives the whole send 8s; leave room for the D1 write and the hop back. */
const SEND_DEADLINE_MS = 6_500;

export type PushTicket =
    | { status: 'ok'; id: string }
    | {
        status: 'error';
        message: string;
        details?: { error?: PushErrorCode; provider?: ProviderName; reason?: string };
    };

interface Job {
    index: number;
    device: DeviceRecord;
    message: PushMessage;
}

export async function sendPushMessages(env: Env, messages: readonly PushMessage[]): Promise<PushTicket[]> {
    const now = Date.now();
    const signal = AbortSignal.timeout(SEND_DEADLINE_MS);

    const recipients = messages.flatMap((message) =>
        (Array.isArray(message.to) ? message.to : [message.to]).map((to) => ({ to, message }))
    );
    const ids = [...new Set(recipients.map(({ to }) => parsePushToken(to)).filter((id): id is string => id !== null))];
    const devices = await findDevices(env.DB, ids);
    const credentials = createRequestCredentials(env, now, signal);
    const deliveries: DeliveryRecord[] = [];
    const tickets = new Array<PushTicket>(recipients.length);

    const settle = (job: Job, result: ProviderResult | ExpoResult, ticketId: string) => {
        if (result.ok) {
            deliveries.push({ kind: 'sent', device: job.device });
            tickets[job.index] = { status: 'ok', id: 'id' in result ? result.id : ticketId };
            return;
        }
        console.log(
            `push: ${result.provider} failed device=${job.device.id.slice(0, 6)} token=${redactToken(job.device.pushToken)} ` +
            `reason=${result.reason} status=${result.httpStatus ?? '-'} unregistered=${result.unregistered}`
        );
        deliveries.push(result.unregistered
            ? { kind: 'unregistered', device: job.device, error: `${result.provider}:${result.reason}` }
            : { kind: 'failed', device: job.device, error: `${result.provider}:${result.reason}` });
        tickets[job.index] = errorTicket(job.device, result);
    };

    // Resolve every recipient first, so Expo installs can be batched.
    const jobs = (await Promise.all(recipients.map(async ({ to, message }, index): Promise<Job | null> => {
        const id = parsePushToken(to);
        const device = id ? devices.get(id) : undefined;
        if (!device || !device.active) {
            tickets[index] = {
                status: 'error',
                message: `"${to}" is not a registered push notification recipient`,
                details: { error: 'DeviceNotRegistered' },
            };
            return null;
        }
        // Keyed by recipient, not sender: the hosted happy-server sends for
        // every user from a few IPs, while one token getting flooded is the
        // abuse an open send endpoint invites. Unknown tokens are answered
        // above without touching the limiter.
        if (!(await isWithinLimit(env.SEND_RATE_LIMITER, `send:${device.id}`))) {
            tickets[index] = {
                status: 'error',
                message: `Too many notifications to "${formatPushToken(device.id)}"; retry in a minute`,
                details: { error: 'MessageRateExceeded', reason: 'RecipientRateLimited' },
            };
            return null;
        }
        return { index, device, message };
    }))).filter((job): job is Job => job !== null);

    // One task per native recipient and one per Expo batch, all sharing the
    // same connection budget and deadline.
    const tasks: Array<() => Promise<void>> = [];
    const expoByApp = new Map<string, Job[]>();
    for (const job of jobs) {
        if (job.device.provider !== 'expo') {
            tasks.push(async () => {
                if (signal.aborted) {
                    settle(job, providerFailure(job.device.provider, 'Timeout'), '');
                    return;
                }
                const ticketId = crypto.randomUUID();
                settle(job, await deliver(job.device, job.message, ticketId, credentials, now, signal), ticketId);
            });
            continue;
        }
        // Expo rejects a batch that mixes tokens of different Expo projects,
        // and one app id is one project.
        const group = expoByApp.get(job.device.appId) ?? [];
        group.push(job);
        expoByApp.set(job.device.appId, group);
    }
    for (const group of expoByApp.values()) {
        for (let i = 0; i < group.length; i += EXPO_BATCH_SIZE) {
            const batch = group.slice(i, i + EXPO_BATCH_SIZE);
            tasks.push(async () => {
                const results = signal.aborted
                    ? batch.map(() => providerFailure('expo', 'Timeout'))
                    : await sendExpoBatch(batch, signal);
                batch.forEach((job, j) => settle(job, results[j]!, ''));
            });
        }
    }
    await mapWithConcurrency(tasks, SEND_CONCURRENCY, (task) => task());

    try {
        await recordDeliveries(env.DB, deliveries, now);
    } catch (error) {
        // Tickets already describe what happened; a failed bookkeeping write
        // must not turn successful deliveries into a 500.
        console.error(`push: failed to record deliveries: ${error instanceof Error ? error.message : String(error)}`);
    }
    return tickets;
}

async function deliver(
    device: DeviceRecord,
    message: PushMessage,
    ticketId: string,
    credentials: RequestCredentials,
    now: number,
    signal: AbortSignal
): Promise<ProviderResult> {
    if (device.provider === 'apns') {
        const auth = await credentials.apns();
        if (!auth.ok) {
            return auth.failure;
        }
        return sendApns({ config: auth.config, jwt: auth.token, device, message, apnsId: ticketId, now, signal });
    }
    const auth = await credentials.fcm();
    if (!auth.ok) {
        return auth.failure;
    }
    return sendFcm({ config: auth.config, accessToken: auth.token, device, message, signal });
}

type Credential<C> = { ok: true; config: C; token: string } | { ok: false; failure: ProviderFailure };

interface RequestCredentials {
    apns(): Promise<Credential<ApnsConfig>>;
    fcm(): Promise<Credential<FcmConfig>>;
}

/**
 * Provider auth for one request, resolved lazily and at most once, so a
 * fan-out to 100 iPhones signs (or fetches) a single token.
 */
function createRequestCredentials(env: Env, now: number, signal: AbortSignal): RequestCredentials {
    let apns: Promise<Credential<ApnsConfig>> | null = null;
    let fcm: Promise<Credential<FcmConfig>> | null = null;
    return {
        apns: () => apns ??= resolveApns(env, now),
        fcm: () => fcm ??= resolveFcm(env, now, signal),
    };
}

async function resolveApns(env: Env, now: number): Promise<Credential<ApnsConfig>> {
    const config = readApnsConfig(env);
    if (!config) {
        return { ok: false, failure: providerFailure('apns', 'APNs credentials are not configured', { error: 'InvalidCredentials' }) };
    }
    try {
        return { ok: true, config, token: await getApnsJwt(config, now) };
    } catch (error) {
        console.error(`push: APNs key unusable: ${error instanceof Error ? error.message : String(error)}`);
        return { ok: false, failure: providerFailure('apns', 'APNs private key could not be used for signing', { error: 'InvalidCredentials' }) };
    }
}

async function resolveFcm(env: Env, now: number, signal: AbortSignal): Promise<Credential<FcmConfig>> {
    let config: FcmConfig | null;
    try {
        config = readFcmConfig(env);
    } catch (error) {
        const reason = error instanceof FcmConfigError ? error.message : 'FCM_SERVICE_ACCOUNT is invalid';
        return { ok: false, failure: providerFailure('fcm', reason, { error: 'InvalidCredentials' }) };
    }
    if (!config) {
        return { ok: false, failure: providerFailure('fcm', 'FCM credentials are not configured', { error: 'InvalidCredentials' }) };
    }
    try {
        return { ok: true, config, token: await getFcmAccessToken(config, now, signal) };
    } catch (error) {
        if (error instanceof FcmAuthError) {
            console.error(`push: FCM auth failed: ${error.message}`);
            return { ok: false, failure: providerFailure('fcm', 'FCM OAuth token request was rejected', { error: 'InvalidCredentials' }) };
        }
        return { ok: false, failure: providerFailure('fcm', fetchFailureReason(error)) };
    }
}

function errorTicket(device: DeviceRecord, result: ProviderFailure): PushTicket {
    return {
        status: 'error',
        message: ticketMessage(device, result.error, result.reason),
        details: { error: result.error, provider: result.provider, reason: result.reason },
    };
}

const providerLabel: Record<DeviceRecord['provider'], string> = { apns: 'APNs', fcm: 'FCM', expo: 'Expo push' };

function ticketMessage(device: DeviceRecord, error: PushErrorCode | undefined, reason: string): string {
    const recipient = `"${formatPushToken(device.id)}"`;
    switch (error) {
        case 'DeviceNotRegistered':
            return `${recipient} is not a registered push notification recipient (${reason})`;
        case 'InvalidCredentials':
            return `${providerLabel[device.provider]} credentials are invalid or missing (${reason})`;
        case 'MessageTooBig':
            return 'Notification payload exceeds the 4096-byte limit';
        case 'MessageRateExceeded':
            return `Provider is throttling notifications to ${recipient} (${reason})`;
        case 'MismatchSenderId':
            return `${recipient} belongs to a different FCM sender (${reason})`;
        default:
            return `Delivery to ${recipient} failed (${reason})`;
    }
}
