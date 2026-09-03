import { describe, expect, it } from 'vitest';
import {
    isAllowedLifecycleAbort,
    matchesExpectedBrowserResponse,
    type BrowserRequestFailure,
    type BrowserResponseSummary,
    type ExpectedBrowserResponse,
} from '../../e2e/public-session-sharing-diagnostics';

describe('public session sharing browser diagnostics', () => {
    it('allows only known image/media lifecycle abort URLs', () => {
        const allowedUrlPrefixes = [
            'http://localhost:43100/assets/',
            'blob:http://localhost:43100/',
            'http://localhost:43101/v1/public/session-shares/public-id/attachments/',
        ];
        const base: BrowserRequestFailure = {
            description: 'fixture',
            error: 'net::ERR_ABORTED',
            resourceType: 'image',
            url: 'http://localhost:43100/assets/?unstable_path=cover.png',
        };

        expect(isAllowedLifecycleAbort(base, allowedUrlPrefixes)).toBe(true);
        expect(isAllowedLifecycleAbort({
            ...base,
            resourceType: 'media',
            url: 'blob:http://localhost:43100/fixture-id',
        }, allowedUrlPrefixes)).toBe(true);
        expect(isAllowedLifecycleAbort({
            ...base,
            url: 'http://localhost:43101/v1/public/session-shares/public-id/attachments/cover-id',
        }, allowedUrlPrefixes)).toBe(true);

        for (const mutation of [
            { url: 'http://localhost:43100/unexpected.png' },
            { resourceType: 'fetch' },
            { resourceType: 'xhr' },
            { resourceType: 'document' },
            { error: 'net::ERR_FAILED' },
        ]) {
            expect(isAllowedLifecycleAbort({ ...base, ...mutation }, allowedUrlPrefixes)).toBe(false);
        }
    });

    it('matches expected HTTP failures by active phase, origin, method, path, and status', () => {
        let revokePhase = false;
        const expected: ExpectedBrowserResponse = {
            enabled: () => revokePhase,
            expectedCount: 1,
            label: 'revoked public snapshot',
            method: 'GET',
            origin: 'http://localhost:43101',
            pathname: '/v1/public/session-shares/public-id',
            status: 404,
        };
        const actual: BrowserResponseSummary = {
            method: 'GET',
            origin: 'http://localhost:43101',
            pathname: '/v1/public/session-shares/public-id',
            status: 404,
        };

        expect(matchesExpectedBrowserResponse(actual, expected)).toBe(false);
        revokePhase = true;
        expect(matchesExpectedBrowserResponse(actual, expected)).toBe(true);
        expect(matchesExpectedBrowserResponse({ ...actual, origin: 'http://evil.invalid' }, expected)).toBe(false);
        expect(matchesExpectedBrowserResponse({ ...actual, method: 'POST' }, expected)).toBe(false);
        expect(matchesExpectedBrowserResponse({ ...actual, pathname: `${actual.pathname}/attachments/asset` }, expected)).toBe(false);
        expect(matchesExpectedBrowserResponse({ ...actual, status: 503 }, expected)).toBe(false);
    });
});
