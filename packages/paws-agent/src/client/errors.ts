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
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
            return new PawsAgentError('RPC_TIMEOUT', 'Request timed out', { cause: error });
        }

        switch (error.response?.status) {
            case 401:
                return new PawsAgentError('AUTH_EXPIRED', 'Authentication expired', { cause: error });
            case 403:
                return new PawsAgentError('FORBIDDEN', 'Request forbidden', { cause: error });
            case 404:
                return new PawsAgentError('NOT_FOUND', context ? `Not found: ${context}` : 'Not found', { cause: error });
            default:
                return new PawsAgentError('UNKNOWN', context ? `Request failed: ${context}` : 'Request failed', { cause: error });
        }
    }

    return new PawsAgentError('UNKNOWN', context ? `Operation failed: ${context}` : 'Operation failed', { cause: error });
}
