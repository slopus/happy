import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildMcpAppSandboxVerificationUrls,
    verifyProductionMcpAppSandbox,
} from './verify-production-mcp-app-sandbox.mjs';

const sandboxOrigin = 'https://sandbox.paws.example';
const parentOrigin = 'https://paws.example:8443';

function response(status, headers, body = '') {
    return new Response(body, { status, headers });
}

function validFetch(overrides = {}) {
    const urls = buildMcpAppSandboxVerificationUrls(sandboxOrigin, parentOrigin);
    return async (url) => {
        if (url === urls.acceptedHost) return response(200, {
            'cache-control': 'no-store',
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:; font-src data:; connect-src 'none'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${parentOrigin}`,
            'permissions-policy': 'camera=(), microphone=(), geolocation=(), clipboard-write=()',
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
            'cross-origin-resource-policy': 'cross-origin',
            ...overrides.accepted,
        }, '<!doctype html>');
        if (url === urls.hostScript) return response(200, {
            'cache-control': 'no-store',
            'content-type': 'text/javascript; charset=utf-8',
            'x-content-type-options': 'nosniff',
            'cross-origin-resource-policy': 'same-origin',
            ...overrides.script,
        }, 'void 0;');
        return response(404, { 'cache-control': 'no-store', ...overrides.rejected }, '{"error":"Not found"}');
    };
}

test('verifies exact separated origins, accepted/rejected parent, headers, JS, and 404 scope', async () => {
    const result = await verifyProductionMcpAppSandbox({ sandboxOrigin, parentOrigin, fetchImpl: validFetch() });
    assert.deepEqual(result, { checks: 4 });
});

test('fails closed for same origins or non-HTTPS production origins before fetch', async () => {
    await assert.rejects(verifyProductionMcpAppSandbox({
        sandboxOrigin: parentOrigin, parentOrigin, fetchImpl: async () => { throw new Error('must not fetch'); },
    }), /different origin/i);
    await assert.rejects(verifyProductionMcpAppSandbox({
        sandboxOrigin: 'http://sandbox.paws.example', parentOrigin,
        fetchImpl: async () => { throw new Error('must not fetch'); },
    }), /HTTPS/i);
});

for (const [label, overrides, pattern] of [
    ['cache', { accepted: { 'cache-control': 'public' } }, /no-store/i],
    ['CSP parent', { accepted: { 'content-security-policy': "default-src 'none'; frame-ancestors https://evil.example" } }, /CSP|frame-ancestors/i],
    ['permissions', { accepted: { 'permissions-policy': 'camera=()' } }, /permissions-policy/i],
    ['nosniff', { accepted: { 'x-content-type-options': 'open' } }, /nosniff/i],
    ['referrer', { accepted: { 'referrer-policy': 'origin' } }, /referrer/i],
    ['HTML MIME', { accepted: { 'content-type': 'text/plain' } }, /content-type/i],
    ['JS MIME', { script: { 'content-type': 'text/html' } }, /javascript/i],
    ['HTML CORP', { accepted: { 'cross-origin-resource-policy': 'same-origin' } }, /resource-policy/i],
    ['JS CORP', { script: { 'cross-origin-resource-policy': 'cross-origin' } }, /resource-policy/i],
    ['CORS', { accepted: { 'access-control-allow-origin': '*' } }, /CORS/i],
]) {
    test(`rejects invalid ${label}`, async () => {
        await assert.rejects(verifyProductionMcpAppSandbox({
            sandboxOrigin, parentOrigin, fetchImpl: validFetch(overrides),
        }), pattern);
    });
}

test('rejects an accepted-parent 404, rejected-parent 200, unknown 200, or script 404', async () => {
    const urls = buildMcpAppSandboxVerificationUrls(sandboxOrigin, parentOrigin);
    for (const failedUrl of Object.values(urls)) {
        const base = validFetch();
        await assert.rejects(verifyProductionMcpAppSandbox({
            sandboxOrigin,
            parentOrigin,
            fetchImpl: async (url) => response(url === failedUrl ? (failedUrl === urls.acceptedHost || failedUrl === urls.hostScript ? 404 : 200) : (await base(url)).status,
                Object.fromEntries((await base(url)).headers), await (await base(url)).text()),
        }), /HTTP/i);
    }
});

test('rejects permissive or duplicate CSP and Permissions-Policy values', async () => {
    for (const accepted of [
        { 'content-security-policy': `default-src 'none'; script-src * 'unsafe-eval'; frame-ancestors ${parentOrigin}` },
        { 'content-security-policy': `default-src 'none'; default-src *; frame-ancestors ${parentOrigin}` },
        { 'permissions-policy': 'camera=(), camera=*, microphone=(), geolocation=(), clipboard-write=()' },
    ]) {
        await assert.rejects(verifyProductionMcpAppSandbox({ sandboxOrigin, parentOrigin, fetchImpl: validFetch({ accepted }) }), /CSP|permissions-policy/i);
    }
});

test('applies the per-request deadline when fetch never settles', async () => {
    const started = Date.now();
    await assert.rejects(verifyProductionMcpAppSandbox({
        sandboxOrigin, parentOrigin, fetchImpl: () => new Promise(() => {}), requestTimeoutMs: 10, overallTimeoutMs: 1_000,
    }), /timed out/i);
    assert.ok(Date.now() - started < 500);
});

test('applies the overall deadline when it is shorter and leaves no live timeout', async () => {
    const started = Date.now();
    await assert.rejects(verifyProductionMcpAppSandbox({
        sandboxOrigin, parentOrigin, fetchImpl: () => new Promise(() => {}), requestTimeoutMs: 10_000, overallTimeoutMs: 10,
    }), /timed out/i);
    assert.ok(Date.now() - started < 500);
});
