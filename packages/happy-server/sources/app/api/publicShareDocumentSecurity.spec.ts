import { describe, expect, it } from 'vitest';
import {
    getPublicShareDocumentHeaders,
    isPublicShareDocumentUrl,
    isSpaFallbackExcludedUrl,
    resolveTrustProxySetting,
} from './api';

describe('public share HTML security', () => {
    it('recognizes only complete public share document routes', () => {
        expect(isPublicShareDocumentUrl('/share/public-id')).toBe(true);
        expect(isPublicShareDocumentUrl('/share/public-id/?source=test')).toBe(true);
        expect(isPublicShareDocumentUrl('/share')).toBe(false);
        expect(isPublicShareDocumentUrl('/session/private-id')).toBe(false);
    });

    it('sets no-store, noindex, and a framing/form/object restrictive CSP', () => {
        const headers = getPublicShareDocumentHeaders();
        expect(headers['Cache-Control']).toBe('no-store');
        expect(headers['X-Robots-Tag']).toContain('noindex');
        expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
        expect(headers['Content-Security-Policy']).toContain("form-action 'none'");
        expect(headers['Content-Security-Policy']).toContain("object-src 'none'");
    });

    it('trusts only an explicitly configured number of reverse-proxy hops', () => {
        expect(resolveTrustProxySetting(undefined)).toBe(false);
        expect(resolveTrustProxySetting('1')).toBe(1);
        expect(resolveTrustProxySetting('0')).toBe(false);
        expect(resolveTrustProxySetting('true')).toBe(false);
    });

    it('never serves the Web SPA for unmatched MCP App sandbox paths', () => {
        expect(isSpaFallbackExcludedUrl('/mcp-app-sandbox')).toBe(true);
        expect(isSpaFallbackExcludedUrl('/mcp-app-sandbox?parentOrigin=secret')).toBe(true);
        expect(isSpaFallbackExcludedUrl('/mcp-app-sandbox/host/extra')).toBe(true);
        expect(isSpaFallbackExcludedUrl('/mcp-app-sandbox/unknown?parentOrigin=x')).toBe(true);
        expect(isSpaFallbackExcludedUrl('/conversation/session-id')).toBe(false);
    });
});
