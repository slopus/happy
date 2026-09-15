import { describe, expect, it } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { inspect } from 'node:util';
import { normalizeHttpError, PawsAgentError } from './errors';

describe('PawsAgentError', () => {
    it('normalizes 401 without retaining authorization data', () => {
        const cause = {
            isAxiosError: true,
            message: 'request failed with token secret-value',
            response: { status: 401, data: { token: 'secret-value' } },
            config: { headers: { Authorization: 'Bearer secret-value' } },
        };

        const error = normalizeHttpError(cause, 'listing machines');

        expect(error).toBeInstanceOf(PawsAgentError);
        expect(error.code).toBe('AUTH_EXPIRED');
        expect(error.message).toBe('Authentication expired');
        expect(JSON.stringify(error)).not.toContain('secret-value');
        expect(inspect(error, { depth: null })).not.toContain('secret-value');
        expect(error.cause).toBeUndefined();
        expect(Object.keys(error)).not.toContain('cause');
    });

    it('maps timeout failures to a stable code', () => {
        const error = normalizeHttpError({ isAxiosError: true, code: 'ECONNABORTED' });
        expect(error.code).toBe('RPC_TIMEOUT');
    });

    it.each([
        [401, undefined, 'AUTH_EXPIRED'],
        [403, undefined, 'FORBIDDEN'],
        [404, undefined, 'NOT_FOUND'],
        [500, undefined, 'UNKNOWN'],
        [409, undefined, 'UNKNOWN'],
        [409, 'ECONNABORTED', 'RPC_TIMEOUT'],
        [409, 'ETIMEDOUT', 'RPC_TIMEOUT'],
    ])('does not expose Axios secrets through JSON, inspection or cause (%i / %s)', (status, code, expectedCode) => {
        const config = { headers: new AxiosHeaders({ Authorization: 'Bearer secret-canary' }), url: 'https://example.invalid/?token=secret-canary' };
        const cause = new AxiosError('secret-canary', code, config, undefined, {
            status, statusText: 'secret-canary', headers: {}, config,
            data: { error: 'codex-account-unbound', access_token: 'secret-canary', grant: 'secret-canary' },
        });
        const error = normalizeHttpError(cause, 'POST /v1/codex-session-grants');
        expect(error.code).toBe(expectedCode);
        expect(JSON.stringify(error)).not.toContain('secret-canary');
        expect(inspect(error, { depth: null, showHidden: true })).not.toContain('secret-canary');
        expect(error.cause).toBeUndefined();
        if (status === 409 && !code) expect(error.details).toEqual({ status: 409, errorCode: 'codex-account-unbound' });
    });

    it('preserves existing PawsAgentError and non-Axios error semantics', () => {
        const original = new Error('non-axios');
        const normalized = new PawsAgentError('INVALID_ARGUMENT', 'invalid', { cause: original });
        expect(normalizeHttpError(normalized)).toBe(normalized);
        expect(normalizeHttpError(original)).toMatchObject({ code: 'UNKNOWN', cause: original });
    });
});
