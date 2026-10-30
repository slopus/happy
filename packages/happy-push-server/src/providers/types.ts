/** Ticket error codes, named as Expo names them so existing senders keep working. */
export type PushErrorCode =
    | 'DeviceNotRegistered'
    | 'InvalidCredentials'
    | 'MessageTooBig'
    | 'MessageRateExceeded'
    | 'MismatchSenderId';

export type ProviderName = 'apns' | 'fcm' | 'expo';

export interface ProviderFailure {
    ok: false;
    provider: ProviderName;
    /** Expo-compatible code when the failure maps to one; absent for transient errors. */
    error?: PushErrorCode;
    /** Provider's own reason string (APNs `reason`, FCM `errorCode`/`status`), or a local one. */
    reason: string;
    /** The native token is dead: deactivate the install. */
    unregistered: boolean;
    httpStatus?: number;
}

export type ProviderResult = { ok: true } | ProviderFailure;

export function providerFailure(
    provider: ProviderName,
    reason: string,
    options: { error?: PushErrorCode; unregistered?: boolean; httpStatus?: number } = {}
): ProviderFailure {
    return {
        ok: false,
        provider,
        reason,
        error: options.error,
        unregistered: options.unregistered ?? false,
        httpStatus: options.httpStatus,
    };
}

/** Classifies a thrown fetch error (deadline abort vs. network failure). */
export function fetchFailureReason(error: unknown): string {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        return 'Timeout';
    }
    return 'NetworkError';
}
