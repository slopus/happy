import type { ServiceErrorCode } from '@slopus/happy-wire';

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Codex 0.159.3 generated app-server schema: TurnError.codexErrorInfo.
 * JSON-RPC standard method/parameter errors are protocol/parameter failures.
 * Diagnostics, messages and arbitrary HTTP statuses never imply a public category.
 */
export function codexServiceError(value: unknown): ServiceErrorCode {
    const error = object(value);
    if (error.code === -32601) return 'protocol-incompatible';
    if (error.code === -32602) return 'parameter-unsupported';
    switch (error.codexErrorInfo) {
        case 'usageLimitExceeded': case 'rateLimitExceeded': return 'quota-exhausted';
        case 'unauthorized': return 'account-login-required';
        case 'contextWindowExceeded': case 'badRequest': return 'parameter-unsupported';
        default: return 'execution-interrupted';
    }
}
/** Claude Code SDKAssistantMessage.error enum. Do not classify result.errors text. */
export function claudeServiceError(value: unknown): ServiceErrorCode {
    switch (value) {
        case 'authentication_failed': return 'account-login-required';
        case 'rate_limit': return 'quota-exhausted';
        case 'model_not_found': return 'model-unavailable';
        case 'invalid_request': return 'parameter-unsupported';
        default: return 'execution-interrupted';
    }
}
