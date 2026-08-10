import { describe, expect, it } from 'vitest';
import { resolveErrorStatusCode } from './enableErrorHandlers';

describe('resolveErrorStatusCode', () => {
    it('uses 500 for an unclassified error before Fastify updates the reply', () => {
        expect(resolveErrorStatusCode(200)).toBe(500);
    });

    it('preserves explicit error and reply status codes', () => {
        expect(resolveErrorStatusCode(200, 429)).toBe(429);
        expect(resolveErrorStatusCode(503)).toBe(503);
    });
});
