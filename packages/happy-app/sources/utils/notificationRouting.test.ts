import { describe, expect, it } from 'vitest';
import {
    getPublicSessionShareRetrySessionId,
    getSessionRouteFromNotificationData,
    getSessionRouteFromNotificationResponse,
} from './notificationRouting';

describe('getSessionRouteFromNotificationData', () => {
    it('returns a session route when sessionId exists', () => {
        expect(getSessionRouteFromNotificationData({ sessionId: 'session-123' })).toBe('/session/session-123');
    });

    it('encodes session ids that contain spaces', () => {
        expect(getSessionRouteFromNotificationData({ sessionId: 'session 123' })).toBe('/session/session%20123');
    });

    it('returns null when sessionId is missing', () => {
        expect(getSessionRouteFromNotificationData({ kind: 'done' })).toBeNull();
    });

    it('returns null for empty session ids', () => {
        expect(getSessionRouteFromNotificationData({ sessionId: '   ' })).toBeNull();
    });

    it('uses a session url when present', () => {
        expect(getSessionRouteFromNotificationData({ url: '/session/session-123' })).toBe('/session/session-123');
    });
});

describe('getSessionRouteFromNotificationResponse', () => {
    it('reads the route from content data', () => {
        expect(getSessionRouteFromNotificationResponse({
            notification: {
                request: {
                    content: {
                        data: { sessionId: 'session-123' }
                    }
                }
            }
        })).toBe('/session/session-123');
    });

    it('returns null when content data is missing', () => {
        expect(getSessionRouteFromNotificationResponse({
            notification: {
                request: {
                    content: {}
                }
            }
        })).toBeNull();
    });
});

describe('getPublicSessionShareRetrySessionId', () => {
    it('returns the session only for a failed share notification', () => {
        expect(getPublicSessionShareRetrySessionId({
            notification: { request: { content: { data: { kind: 'share-failed', sessionId: 'session-123' } } } },
        })).toBe('session-123');
        expect(getPublicSessionShareRetrySessionId({
            notification: { request: { content: { data: { kind: 'share-ready', sessionId: 'session-123' } } } },
        })).toBeNull();
    });
});
