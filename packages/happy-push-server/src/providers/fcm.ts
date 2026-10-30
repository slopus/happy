/**
 * FCM HTTP v1 with a service-account OAuth token.
 *
 * Messages are data-only and use the key layout Expo's push service uses
 * (`title`, `message`, `body` = JSON string of `data`, `channelId`, ...),
 * because that is what expo-notifications' FirebaseMessagingDelegate builds
 * the visible notification from (NotificationData.kt), and its
 * NotificationSerializer JSON-parses `body` into `request.content.data`.
 * A data-only message also reaches the app's handler in the foreground and
 * background alike, which a `notification` message would not.
 */

import type { Env } from '@/env';
import { importPkcs8Key, signJwt } from '@/providers/jwt';
import { fetchFailureReason, providerFailure, type ProviderResult } from '@/providers/types';
import { resolvePriority, type PushMessage } from '@/schema';
import type { DeviceRecord } from '@/storage/devices';
import { utf8Length } from '@/utils/encoding';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
/** FCM's limit on the data payload. */
const MAX_DATA_BYTES = 4096;
/** Refresh this long before Google's stated expiry (tokens live 1h → ~55 min). */
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export interface FcmConfig {
    projectId: string;
    clientEmail: string;
    privateKey: string;
    tokenUri: string;
}

export class FcmConfigError extends Error {}

/** Returns null when FCM is not configured; throws FcmConfigError when it is configured wrong. */
export function readFcmConfig(env: Env): FcmConfig | null {
    if (!env.FCM_SERVICE_ACCOUNT) {
        return null;
    }
    let account: Record<string, unknown>;
    try {
        account = JSON.parse(env.FCM_SERVICE_ACCOUNT) as Record<string, unknown>;
    } catch {
        throw new FcmConfigError('FCM_SERVICE_ACCOUNT is not valid JSON');
    }
    const { project_id, client_email, private_key, token_uri } = account;
    if (typeof project_id !== 'string' || typeof client_email !== 'string' || typeof private_key !== 'string') {
        throw new FcmConfigError('FCM_SERVICE_ACCOUNT is missing project_id, client_email, or private_key');
    }
    return {
        projectId: project_id,
        clientEmail: client_email,
        privateKey: private_key,
        tokenUri: typeof token_uri === 'string' ? token_uri : DEFAULT_TOKEN_URI,
    };
}

// Settled tokens only; see the note on the APNs JWT cache.
const accessTokenCache = new Map<string, { token: string; expiresAt: number }>();

export class FcmAuthError extends Error {}

export async function getFcmAccessToken(config: FcmConfig, now: number, signal: AbortSignal): Promise<string> {
    const cached = accessTokenCache.get(config.clientEmail);
    if (cached && now < cached.expiresAt) {
        return cached.token;
    }

    const iat = Math.floor(now / 1000);
    let assertion: string;
    try {
        const key = await importPkcs8Key(config.privateKey, 'RS256');
        assertion = await signJwt('RS256', key, { typ: 'JWT' }, {
            iss: config.clientEmail,
            scope: FCM_SCOPE,
            aud: config.tokenUri,
            iat,
            exp: iat + 3600,
        });
    } catch (error) {
        throw new FcmAuthError(`Could not sign service-account assertion: ${error instanceof Error ? error.message : String(error)}`);
    }

    const response = await fetch(config.tokenUri, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion,
        }),
        signal,
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new FcmAuthError(`OAuth token request failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    const json = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof json.access_token !== 'string') {
        throw new FcmAuthError('OAuth token response has no access_token');
    }
    const expiresInMs = (typeof json.expires_in === 'number' ? json.expires_in : 3600) * 1000;
    accessTokenCache.set(config.clientEmail, {
        token: json.access_token,
        expiresAt: now + expiresInMs - TOKEN_EXPIRY_MARGIN_MS,
    });
    return json.access_token;
}

export function invalidateFcmAccessToken(config: FcmConfig, token: string): void {
    if (accessTokenCache.get(config.clientEmail)?.token === token) {
        accessTokenCache.delete(config.clientEmail);
    }
}

export function resetFcmCache(): void {
    accessTokenCache.clear();
}

export function buildFcmMessage(message: PushMessage, device: DeviceRecord): Record<string, unknown> {
    const data: Record<string, string> = {};
    if (message.title) data.title = message.title;
    if (message.body) data.message = message.body;
    if (message.subtitle) data.subtitle = message.subtitle;
    data.body = JSON.stringify(message.data ?? {});
    if (message.channelId) data.channelId = message.channelId;
    if (message.categoryId) data.categoryId = message.categoryId;
    if (message.badge !== undefined) data.badge = String(message.badge);
    // expo-notifications plays the default sound when `sound` is absent, and
    // looks up a bundled resource by name otherwise, so 'default' is omitted.
    if (typeof message.sound === 'string' && message.sound !== 'default') data.sound = message.sound;

    const android: Record<string, unknown> = {
        // Data-only messages need HIGH to wake a dozing device promptly; FCM
        // deprioritizes apps whose HIGH messages do not show a notification,
        // so data-only pushes default to NORMAL (see resolvePriority).
        priority: resolvePriority(message) === 'high' ? 'HIGH' : 'NORMAL',
    };
    if (message.ttl !== undefined) {
        android.ttl = `${message.ttl}s`;
    }

    return { message: { token: device.pushToken, data, android } };
}

export async function sendFcm(params: {
    config: FcmConfig;
    accessToken: string;
    device: DeviceRecord;
    message: PushMessage;
    signal: AbortSignal;
}): Promise<ProviderResult> {
    const fcmMessage = buildFcmMessage(params.message, params.device);
    const data = (fcmMessage.message as { data: Record<string, string> }).data;
    if (utf8Length(JSON.stringify(data)) > MAX_DATA_BYTES) {
        return providerFailure('fcm', 'PayloadTooLarge', { error: 'MessageTooBig' });
    }

    let response: Response;
    try {
        response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(params.config.projectId)}/messages:send`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${params.accessToken}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify(fcmMessage),
            signal: params.signal,
        });
    } catch (error) {
        return providerFailure('fcm', fetchFailureReason(error));
    }

    if (response.ok) {
        await response.body?.cancel();
        return { ok: true };
    }

    const error = await readFcmError(response);
    const result = classifyFcmError(response.status, error);
    if (result.ok === false && result.error === 'InvalidCredentials') {
        invalidateFcmAccessToken(params.config, params.accessToken);
    }
    return result;
}

export interface FcmErrorInfo {
    /** google.rpc status, e.g. INVALID_ARGUMENT. */
    status?: string;
    /** FcmError detail code, e.g. UNREGISTERED. */
    errorCode?: string;
    message?: string;
}

async function readFcmError(response: Response): Promise<FcmErrorInfo> {
    try {
        const json = await response.json() as {
            error?: { status?: unknown; message?: unknown; details?: Array<{ '@type'?: unknown; errorCode?: unknown }> };
        };
        const detail = json.error?.details?.find((d) => typeof d.errorCode === 'string');
        return {
            status: typeof json.error?.status === 'string' ? json.error.status : undefined,
            errorCode: typeof detail?.errorCode === 'string' ? detail.errorCode : undefined,
            message: typeof json.error?.message === 'string' ? json.error.message : undefined,
        };
    } catch {
        return {};
    }
}

// https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode
export function classifyFcmError(status: number, info: FcmErrorInfo): ProviderResult {
    const reason = info.errorCode ?? info.status ?? `HTTP ${status}`;
    const httpStatus = status;
    if (info.errorCode === 'UNREGISTERED' || status === 404) {
        return providerFailure('fcm', reason, { error: 'DeviceNotRegistered', unregistered: true, httpStatus });
    }
    if (info.errorCode === 'INVALID_ARGUMENT' || info.status === 'INVALID_ARGUMENT') {
        // INVALID_ARGUMENT covers both bad tokens and bad payloads; only the
        // former means the install is dead.
        if (/registration token/i.test(info.message ?? '')) {
            return providerFailure('fcm', reason, { error: 'DeviceNotRegistered', unregistered: true, httpStatus });
        }
        if (/too big|too large|exceeds/i.test(info.message ?? '')) {
            return providerFailure('fcm', reason, { error: 'MessageTooBig', httpStatus });
        }
        return providerFailure('fcm', reason, { httpStatus });
    }
    if (info.errorCode === 'SENDER_ID_MISMATCH') {
        return providerFailure('fcm', reason, { error: 'MismatchSenderId', httpStatus });
    }
    if (info.errorCode === 'QUOTA_EXCEEDED' || status === 429) {
        return providerFailure('fcm', reason, { error: 'MessageRateExceeded', httpStatus });
    }
    if (info.errorCode === 'THIRD_PARTY_AUTH_ERROR' || status === 401 || status === 403) {
        return providerFailure('fcm', reason, { error: 'InvalidCredentials', httpStatus });
    }
    return providerFailure('fcm', reason, { httpStatus });
}
