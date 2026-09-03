import { describe, expect, it } from 'vitest';

import {
    encodeSandboxCspMetadata,
    normalizeSandboxOrigin,
    parseSandboxCspMetadata,
    parseSandboxOriginList,
    resolveSandboxRequest,
} from './mcpAppSandboxSecurity';

const productionRequest = {
    requestHost: 'sandbox.paws.example',
    parentOrigin: 'https://paws.example',
    sandboxOrigin: 'https://sandbox.paws.example',
    allowedParentOrigins: ['https://paws.example'],
    development: false,
};

describe('resolveSandboxRequest', () => {
    it('accepts exact HTTPS origins and canonicalizes default ports', () => {
        expect(resolveSandboxRequest({
            ...productionRequest,
            requestHost: 'sandbox.paws.example:443',
            parentOrigin: 'https://paws.example:443',
            sandboxOrigin: 'https://sandbox.paws.example:443',
            allowedParentOrigins: ['https://paws.example:443'],
        })).toEqual({
            ok: true,
            sandboxOrigin: 'https://sandbox.paws.example',
            parentOrigin: 'https://paws.example',
        });
    });

    it.each([
        ['a trailing path', 'https://paws.example/account'],
        ['a normalized dot path', 'https://paws.example/.'],
        ['an encoded normalized path', 'https://paws.example/%2e'],
        ['a query', 'https://paws.example/?next=1'],
        ['a fragment', 'https://paws.example/#section'],
        ['credentials', 'https://user:secret@paws.example'],
        ['a wildcard', 'https://*.paws.example'],
        ['plain HTTP', 'http://paws.example'],
    ])('rejects a parent origin containing %s', (_label, parentOrigin) => {
        expect(resolveSandboxRequest({
            ...productionRequest,
            parentOrigin,
            allowedParentOrigins: [parentOrigin],
        })).toEqual({ ok: false });
    });

    it('rejects a lookalike parent subdomain', () => {
        expect(resolveSandboxRequest({
            ...productionRequest,
            parentOrigin: 'https://paws.example.evil.test',
        })).toEqual({ ok: false });
    });

    it('rejects a same-origin parent because the Web host requires two origins', () => {
        expect(resolveSandboxRequest({
            ...productionRequest,
            parentOrigin: 'https://sandbox.paws.example',
            allowedParentOrigins: ['https://sandbox.paws.example'],
        })).toEqual({ ok: false });
    });

    it.each([
        'evil-sandbox.paws.example',
        'sandbox.paws.example.evil.test',
        'sandbox.paws.example:8443',
    ])('rejects a non-sandbox request host %s', (requestHost) => {
        expect(resolveSandboxRequest({ ...productionRequest, requestHost })).toEqual({ ok: false });
    });

    it('accepts HTTP localhost with an exact port only in development', () => {
        const input = {
            requestHost: 'localhost:3005',
            parentOrigin: 'http://localhost:8081',
            sandboxOrigin: 'http://localhost:3005',
            allowedParentOrigins: ['http://localhost:8081'],
        };

        expect(resolveSandboxRequest({ ...input, development: true })).toEqual({
            ok: true,
            sandboxOrigin: 'http://localhost:3005',
            parentOrigin: 'http://localhost:8081',
        });
        expect(resolveSandboxRequest({ ...input, development: false })).toEqual({ ok: false });
        expect(resolveSandboxRequest({
            ...input,
            parentOrigin: 'http://localhost.evil.test:8081',
            allowedParentOrigins: ['http://localhost.evil.test:8081'],
            development: true,
        })).toEqual({ ok: false });
    });

    it.each([
        ['127.1:3005', 'http://127.0.0.1:3005'],
        ['2130706433:3005', 'http://127.0.0.1:3005'],
        ['0177.0.0.1:3005', 'http://127.0.0.1:3005'],
        ['0x7f000001:3005', 'http://127.0.0.1:3005'],
        ['LOCALHOST:3005', 'http://localhost:3005'],
        ['localhost:', 'http://localhost'],
        ['localhost:08080', 'http://localhost:8080'],
    ])('rejects a normalized development request Host %s', (requestHost, sandboxOrigin) => {
        expect(resolveSandboxRequest({
            requestHost,
            parentOrigin: 'http://localhost:8081',
            sandboxOrigin,
            allowedParentOrigins: ['http://localhost:8081'],
            development: true,
        })).toEqual({ ok: false });
    });

    it('rejects missing and empty production configuration', () => {
        expect(resolveSandboxRequest({ ...productionRequest, sandboxOrigin: undefined })).toEqual({ ok: false });
        expect(resolveSandboxRequest({ ...productionRequest, allowedParentOrigins: [] })).toEqual({ ok: false });
    });
});

describe('development loopback origin spelling', () => {
    it.each([
        ['http://localhost:3005', 'http://localhost:3005'],
        ['http://127.0.0.1:3005/', 'http://127.0.0.1:3005'],
        ['http://[::1]:3005', 'http://[::1]:3005'],
    ])('accepts the literal authority %s', (raw, expected) => {
        expect(normalizeSandboxOrigin(raw, true)).toBe(expected);
    });

    it.each([
        'http://127.1:3005',
        'http://2130706433:3005',
        'http://0177.0.0.1:3005',
        'http://0x7f000001:3005',
        'http://LOCALHOST:3005',
        'http://%6cocalhost:3005',
        'http://localhost:',
        'http://localhost:0',
        'http://localhost:08080',
        'http://localhost:65536',
        'http://user@localhost:3005',
        'http://localhost:3005/path',
        'http://localhost:3005?query=1',
        'http://localhost:3005?',
        'http://localhost:3005#fragment',
        'http://localhost:3005#',
    ])('rejects the non-canonical or unsafe authority %s', (raw) => {
        expect(normalizeSandboxOrigin(raw, true)).toBeNull();
    });
});

describe('raw origin delimiters', () => {
    it.each([
        'https://sandbox.paws.example?mode=1',
        'https://sandbox.paws.example?',
        'https://sandbox.paws.example#host',
        'https://sandbox.paws.example#',
    ])('rejects query and fragment delimiters before URL normalization: %s', (raw) => {
        expect(normalizeSandboxOrigin(raw, false)).toBeNull();
    });
});

describe('parseSandboxOriginList', () => {
    it('parses a comma-separated allowlist into canonical exact origins', () => {
        expect(parseSandboxOriginList(
            'https://paws.example:443, https://admin.paws.example/',
            false,
        )).toEqual(['https://paws.example', 'https://admin.paws.example']);
    });

    it('fails closed when one configured origin is empty or malformed', () => {
        expect(parseSandboxOriginList('https://paws.example,,https://admin.paws.example', false)).toBeNull();
        expect(parseSandboxOriginList('https://paws.example,https://*.paws.example', false)).toBeNull();
    });
});

describe('sandbox CSP metadata', () => {
    it('round-trips only canonical declared origins', () => {
        const encoded = encodeSandboxCspMetadata({
            connectDomains: ['https://api.example:443'],
            resourceDomains: ['https://cdn.example', 'https://cdn.example/'],
            frameDomains: ['https://frames.example:8443'],
        }, false);

        expect(encoded).not.toBeNull();
        expect(parseSandboxCspMetadata(encoded!, false)).toEqual({
            connectDomains: ['https://api.example'],
            resourceDomains: ['https://cdn.example'],
            frameDomains: ['https://frames.example:8443'],
        });
    });

    it.each([
        ['credentials', 'https://user:secret@api.example'],
        ['a path', 'https://api.example/v1'],
        ['a query', 'https://api.example/?v=1'],
        ['an empty query delimiter', 'https://api.example?'],
        ['a fragment', 'https://api.example/#v1'],
        ['an empty fragment delimiter', 'https://api.example#'],
        ['a wildcard', 'https://*.api.example'],
        ['plain HTTP', 'http://api.example'],
        ['a directive separator', 'https://api.example;script-src.example'],
    ])('rejects CSP origins containing %s', (_label, origin) => {
        expect(encodeSandboxCspMetadata({
            connectDomains: [origin],
            resourceDomains: [],
            frameDomains: [],
        }, false)).toBeNull();
    });

    it('permits HTTP loopback CSP origins only in development', () => {
        const metadata = {
            connectDomains: ['http://127.0.0.1:9000'],
            resourceDomains: ['http://localhost:8080'],
            frameDomains: [],
        };
        const encoded = encodeSandboxCspMetadata(metadata, true);

        expect(encoded).not.toBeNull();
        expect(parseSandboxCspMetadata(encoded!, true)).toEqual(metadata);
        expect(encodeSandboxCspMetadata(metadata, false)).toBeNull();
    });

    it('rejects more than 32 origins in one category', () => {
        expect(encodeSandboxCspMetadata({
            connectDomains: Array.from({ length: 33 }, (_, index) => `https://api-${index}.example`),
            resourceDomains: [],
            frameDomains: [],
        }, false)).toBeNull();
    });

    it('rejects an encoded policy larger than 8 KiB', () => {
        const longDomains = Array.from({ length: 32 }, (_, index) => (
            `https://${'a'.repeat(50)}.${'b'.repeat(50)}.${'c'.repeat(50)}.${index}.example`
        ));
        const raw = Buffer.from(JSON.stringify({
            connectDomains: longDomains,
            resourceDomains: longDomains,
            frameDomains: longDomains,
        })).toString('base64url');

        expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(8 * 1024);
        expect(parseSandboxCspMetadata(raw, false)).toBeNull();
    });

    it('rejects non-canonical base64url JSON and unknown keys', () => {
        const wrongKeyOrder = Buffer.from(JSON.stringify({
            frameDomains: [],
            resourceDomains: [],
            connectDomains: [],
        })).toString('base64url');
        const extraKey = Buffer.from(JSON.stringify({
            connectDomains: [],
            resourceDomains: [],
            frameDomains: [],
            scriptDomains: [],
        })).toString('base64url');

        expect(parseSandboxCspMetadata(wrongKeyOrder, false)).toBeNull();
        expect(parseSandboxCspMetadata(extraKey, false)).toBeNull();
        expect(parseSandboxCspMetadata('not+base64', false)).toBeNull();
    });
});
