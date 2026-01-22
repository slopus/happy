import { describe, expect, it } from 'vitest';
import { isPublicRouteForUnauthenticated } from './authRouting';

describe('auth routing', () => {
    it('allows root index when unauthenticated', () => {
        expect(isPublicRouteForUnauthenticated(['(app)'])).toBe(true);
        expect(isPublicRouteForUnauthenticated(['(app)', 'index'])).toBe(true);
    });

    it('allows restore routes when unauthenticated', () => {
        expect(isPublicRouteForUnauthenticated(['(app)', 'restore'])).toBe(true);
        expect(isPublicRouteForUnauthenticated(['(app)', 'restore', 'manual'])).toBe(true);
    });

    it('blocks app routes like new-session when unauthenticated', () => {
        expect(isPublicRouteForUnauthenticated(['(app)', 'new'])).toBe(false);
        expect(isPublicRouteForUnauthenticated(['(app)', 'session', 'abc'])).toBe(false);
        expect(isPublicRouteForUnauthenticated(['(app)', 'settings'])).toBe(false);
    });
});

