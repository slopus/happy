import { describe, expect, it, vi } from 'vitest';

import { HappyError } from '@/utils/errors';
import { disconnectService } from './apiServices';

describe('disconnectService', () => {
    it('throws a HappyError when a 404 response body is not JSON', async () => {
        const jsonError = new Error('invalid json');
        (jsonError as any).canTryAgain = false;

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 404,
                json: async () => {
                    throw jsonError;
                },
            })),
        );

        try {
            await disconnectService({ token: 'test' } as any, 'github');
            throw new Error('expected disconnectService to throw');
        } catch (e) {
            expect(e).toBeInstanceOf(HappyError);
            expect((e as HappyError).message).toBe('github account not connected');
        }
    });
});
