import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const verifierPath = fileURLToPath(new URL('./verify-web-release.mjs', import.meta.url));
const revision = '1234567890abcdef1234567890abcdef12345678';

async function createDist() {
    const directory = await mkdtemp(join(tmpdir(), 'paws-web-verify-'));
    await mkdir(join(directory, 'assets'), { recursive: true });
    await writeFile(join(directory, 'index.html'), '<html><head></head><body><script src="/_expo/app.js"></script></body></html>');
    await writeFile(join(directory, '.paws-release-revision'), `${revision}\n`);
    await writeFile(join(directory, 'assets', 'Ionicons.abc123.ttf'), 'ionicons');
    await writeFile(join(directory, 'assets', 'Octicons.def456.ttf'), 'octicons');
    return directory;
}

async function runVerifier({ liveRevision = revision, includeFontCors = true } = {}) {
    const directory = await createDist();
    const server = http.createServer((request, response) => {
        const origin = `http://127.0.0.1:${server.address().port}`;
        if (request.url?.endsWith('.ttf')) {
            response.statusCode = 200;
            response.setHeader('Content-Type', 'font/ttf');
            if (includeFontCors) response.setHeader('Access-Control-Allow-Origin', origin);
            response.end('font');
            return;
        }
        if (request.url === '/' || request.url?.startsWith('/session/') || request.url?.startsWith('/share/')) {
            response.statusCode = 200;
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            if (request.url?.startsWith('/share/')) {
                response.setHeader('Cache-Control', 'no-store');
                response.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
                response.setHeader('X-Content-Type-Options', 'nosniff');
                response.setHeader('Referrer-Policy', 'no-referrer');
                response.setHeader('Content-Security-Policy', "default-src 'self'");
            }
            response.end(`<html><head><meta name="paws-release-revision" content="${liveRevision}"></head></html>`);
            return;
        }
        response.statusCode = 200;
        response.setHeader('Content-Type', request.url?.endsWith('.wasm') ? 'application/wasm' : 'application/json');
        response.end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;

    try {
        const result = await new Promise((resolve) => {
            const child = spawn(process.execPath, [verifierPath, origin, join(directory, 'index.html')], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (chunk) => { stdout += chunk; });
            child.stderr.on('data', (chunk) => { stderr += chunk; });
            child.on('close', (status) => resolve({ status, stdout, stderr }));
        });
        return result;
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await rm(directory, { recursive: true, force: true });
    }
}

test('rejects a live HTML entry from a different release revision', async () => {
    const result = await runVerifier({ liveRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release revision mismatch/i);
});

test('rejects icon fonts that do not authorize the canonical origin', async () => {
    const result = await runVerifier({ includeFontCors: false });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Access-Control-Allow-Origin/i);
});

test('accepts matching HTML and browser-readable Ionicons and Octicons', async () => {
    const result = await runVerifier();

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Ionicons/);
    assert.match(result.stdout, /Octicons/);
    assert.match(result.stdout, new RegExp(revision));
});
