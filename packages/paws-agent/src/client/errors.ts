import axios from 'axios';

export type PawsAgentErrorCode =
    | 'AUTH_REQUIRED'
    | 'AUTH_EXPIRED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'MACHINE_OFFLINE'
    | 'SESSION_ARCHIVED'
    | 'DIRECTORY_APPROVAL_REQUIRED'
    | 'RPC_TIMEOUT'
    | 'CONNECTION_LOST'
    | 'PROTOCOL_UNSUPPORTED'
    | 'DECRYPTION_FAILED'
    | 'INVALID_ARGUMENT'
    | 'UNKNOWN';

export class PawsAgentError extends Error {
    readonly code: PawsAgentErrorCode;
    readonly details?: Readonly<Record<string, unknown>>;
    declare readonly cause?: unknown;

    constructor(
        code: PawsAgentErrorCode,
        message: string,
        options: { cause?: unknown; details?: Readonly<Record<string, unknown>> } = {},
    ) {
        super(message);
        this.name = 'PawsAgentError';
        this.code = code;
        this.details = options.details;
        if (options.cause !== undefined) {
            Object.defineProperty(this, 'cause', {
                configurable: true,
                value: options.cause,
                writable: false,
            });
        }
    }
}

export function normalizeHttpError(error: unknown, context?: string): PawsAgentError {
    if (error instanceof PawsAgentError) {
        return error;
    }

    if (axios.isAxiosError(error)) {
        // Axios retains authorization headers, response bodies and request URLs.
        // Do not attach it as cause: even non-enumerable causes appear in logs.
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
            return new PawsAgentError('RPC_TIMEOUT', 'Request timed out');
        }

        // Preserve only this explicit authorization decision, never arbitrary
        // response bodies (which may contain credentials or provider errors).
        const data: unknown = error.response?.data;
        if (error.response?.status === 409 && data !== null && typeof data === 'object'
            && !Array.isArray(data) && (data as Record<string, unknown>).error === 'codex-account-unbound') {
            return new PawsAgentError('UNKNOWN', context ? `Request failed: ${context}` : 'Request failed', {
                details: { status: 409, errorCode: 'codex-account-unbound' },
            });
        }

        switch (error.response?.status) {
            case 401:
                return new PawsAgentError('AUTH_EXPIRED', 'Authentication expired');
            case 403:
                return new PawsAgentError('FORBIDDEN', 'Request forbidden');
            case 404:
                return new PawsAgentError('NOT_FOUND', context ? `Not found: ${context}` : 'Not found');
            default:
                return new PawsAgentError('UNKNOWN', context ? `Request failed: ${context}` : 'Request failed');
        }
    }

    return new PawsAgentError('UNKNOWN', context ? `Operation failed: ${context}` : 'Operation failed', { cause: error });
}
