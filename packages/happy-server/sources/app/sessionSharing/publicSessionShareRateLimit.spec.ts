import { describe, expect, it, vi } from 'vitest';
import { createPublicShareRateLimiter } from './publicSessionShareRateLimit';

describe('public session share rate limiting', () => {
    it('uses a single-process fallback only when Redis is unavailable', async () => {
        const now = vi.fn(() => 1_000);
        const limiter = createPublicShareRateLimiter({ scope: 'test', max: 2, windowMs: 60_000, now, redisEval: null });

        expect((await limiter.check('owner-a')).allowed).toBe(true);
        expect((await limiter.check('owner-a')).allowed).toBe(true);
        expect((await limiter.check('owner-a')).allowed).toBe(false);
        expect((await limiter.check('owner-b')).allowed).toBe(true);
        now.mockReturnValue(61_001);
        expect((await limiter.check('owner-a')).allowed).toBe(true);
    });

    it('uses a hashed, shared Redis bucket and reports Retry-After', async () => {
        const redisEval = vi.fn(async (_script: string, _keyCount: number, _key: string, _windowMs: string): Promise<unknown> => [3, 12_500]);
        const limiter = createPublicShareRateLimiter({ scope: 'public-read', max: 2, windowMs: 60_000, redisEval });

        expect(await limiter.check('203.0.113.7:public-id')).toEqual({ allowed: false, retryAfterSeconds: 13 });
        expect(redisEval).toHaveBeenCalledOnce();
        const [, keyCount, key, window] = redisEval.mock.calls[0];
        expect(keyCount).toBe(1);
        expect(key).toMatch(/^happy:public-share-rate:public-read:[a-f0-9]{64}$/);
        expect(key).not.toContain('203.0.113.7');
        expect(window).toBe('60000');
    });
});
