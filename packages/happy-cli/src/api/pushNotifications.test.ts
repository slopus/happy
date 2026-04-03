import { describe, expect, it } from 'vitest';
import type { Metadata } from './types';
import {
    getSessionNotificationBody,
    getSessionNotificationCopy,
    getSessionNotificationTitle,
} from './pushNotifications';

function makeMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/Users/test/projects/happy',
        host: 'test-host',
        homeDir: '/Users/test',
        happyHomeDir: '/Users/test/.happy',
        happyLibDir: '/Users/test/.happy/lib',
        happyToolsDir: '/Users/test/.happy/tools',
        ...overrides,
    };
}

describe('getSessionNotificationTitle', () => {
    it('maps done notifications to a ready title', () => {
        expect(getSessionNotificationTitle('done')).toBe("It's ready!");
    });

    it('maps permission notifications to a permission title', () => {
        expect(getSessionNotificationTitle('permission')).toBe('Permission request');
    });

    it('maps question notifications to a clarification title', () => {
        expect(getSessionNotificationTitle('question')).toBe('Clarification needed');
    });
});

describe('getSessionNotificationBody', () => {
    it('uses the session summary when available', () => {
        const metadata = makeMetadata({
            summary: {
                text: 'Fix push notifications',
                updatedAt: 1,
            }
        });

        expect(getSessionNotificationBody(metadata)).toBe('Fix push notifications');
    });

    it('falls back to the last path segment', () => {
        const metadata = makeMetadata({
            path: '/Users/test/projects/happy-cli',
        });

        expect(getSessionNotificationBody(metadata)).toBe('happy-cli');
    });

    it('falls back to a generic label when metadata is missing', () => {
        expect(getSessionNotificationBody(null)).toBe('Session');
    });
});

describe('getSessionNotificationCopy', () => {
    it('returns the fixed title and session title body', () => {
        const metadata = makeMetadata({
            summary: {
                text: 'Fix push notifications',
                updatedAt: 1,
            }
        });

        expect(getSessionNotificationCopy('done', metadata)).toEqual({
            title: "It's ready!",
            body: 'Fix push notifications',
        });
    });
});
