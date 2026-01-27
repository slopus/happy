import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionErrorCode, type SpawnSessionResult } from '@happy/protocol';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSpawnSessionErrorCode(value: unknown): value is SpawnSessionErrorCode {
    if (typeof value !== 'string') return false;
    return (Object.values(SPAWN_SESSION_ERROR_CODES) as string[]).includes(value);
}

export function normalizeSpawnSessionResult(value: unknown): SpawnSessionResult {
    if (!isPlainObject(value)) {
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: 'Malformed spawn result',
        };
    }

    const type = value.type;
    if (type === 'success') {
        const sessionId = typeof value.sessionId === 'string' ? value.sessionId : undefined;
        return { type: 'success', ...(sessionId ? { sessionId } : {}) };
    }

    if (type === 'requestToApproveDirectoryCreation') {
        const directory = typeof value.directory === 'string' ? value.directory : '';
        if (!directory) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: 'Missing directory in spawn result',
            };
        }
        return { type: 'requestToApproveDirectoryCreation', directory };
    }

    if (type === 'error') {
        const errorCode = isSpawnSessionErrorCode(value.errorCode)
            ? value.errorCode
            : SPAWN_SESSION_ERROR_CODES.UNEXPECTED;
        const errorMessage = typeof value.errorMessage === 'string' ? value.errorMessage : 'Failed to spawn session';
        return { type: 'error', errorCode, errorMessage };
    }

    return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'Unknown spawn result type',
    };
}
