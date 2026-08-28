import { describe, expect, it } from 'vitest';
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
        expect(Object.keys(error)).not.toContain('cause');
    });

    it('maps timeout failures to a stable code', () => {
        const error = normalizeHttpError({ isAxiosError: true, code: 'ECONNABORTED' });
        expect(error.code).toBe('RPC_TIMEOUT');
    });
});
