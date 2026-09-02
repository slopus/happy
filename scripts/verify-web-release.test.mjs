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
    await mkdir(join(directory, '_expo'), { recursive: true });
    await mkdir(join(directory, '.well-known'), { recursive: true });
    await writeFile(join(directory, 'index.html'), '<html><head></head><body><script src="/_expo/app.js"></script></body></html>');
    await writeFile(join(directory, '.paws-release-revision'), `${revision}\n`);
    await writeFile(join(directory, 'assets', 'Ionicons.abc123.ttf'), 'ionicons');
    await writeFile(join(directory, 'assets', 'Octicons.def456.ttf'), 'octicons');
    await writeFile(join(directory, 'assets', 'fixture.abc123.png'), 'image');
    await writeFile(join(directory, '_expo', 'app.js'), 'app');
    await writeFile(join(directory, 'metadata.json'), '{}');
    await writeFile(join(directory, 'canvaskit.wasm'), 'wasm');
    await writeFile(join(directory, '.well-known', 'apple-app-site-association'), '{}');
    await writeFile(join(directory, '.well-known', 'assetlinks.json'), '[]');
    return directory;
}

async function runVerifier({
    healthBody = JSON.stringify({ status: 'ok', service: 'happy-server' }),
    healthContentType = 'application/json; charset=utf-8',
    healthFailuresBeforeReady = 0,
    healthNeverResponds = false,
    liveRevision = revision,
    includeFontCors = true,
    mode = 'live',
    scriptContentType = 'application/javascript; charset=utf-8',
    immutableCache = true,
} = {}) {
    const directory = await createDist();
    let healthRequests = 0;
    const server = http.createServer((request, response) => {
        const origin = `http://127.0.0.1:${server.address().port}`;
        if (request.url?.endsWith('.ttf')) {
            response.statusCode = 200;
            response.setHeader('Content-Type', 'font/ttf');
            if (includeFontCors) response.setHeader('Access-Control-Allow-Origin', origin);
            response.setHeader('Cache-Control', 'public,max-age=31536000,immutable');
            response.end('font');
            return;
        }
        if (request.url?.endsWith('.png')) {
            response.statusCode = 200;
            response.setHeader('Content-Type', 'image/png');
            response.setHeader('Cache-Control', 'public,max-age=31536000,immutable');
            response.end('image');
            return;
        }
        if (request.url === `/web/releases/${revision}/index.html`) {
            response.statusCode = 200;
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.setHeader('Cache-Control', immutableCache ? 'public,max-age=31536000,immutable' : 'no-cache');
            response.end(`<html><head><meta name="paws-release-revision" content="${liveRevision}"></head></html>`);
            return;
        }
        if (request.url === `/web/releases/${revision}/.paws-release-revision`) {
            response.statusCode = 200;
            response.setHeader('Content-Type', 'text/plain; charset=utf-8');
            response.setHeader('Cache-Control', immutableCache ? 'public,max-age=31536000,immutable' : 'no-cache');
            response.end(`${liveRevision}\n`);
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
        if (request.url === '/_expo/app.js') {
            response.statusCode = 200;
            response.setHeader('Content-Type', scriptContentType);
            response.setHeader('Cache-Control', 'public,max-age=31536000,immutable');
            response.end('app');
            return;
        }
        if (request.url === '/health') {
            healthRequests += 1;
            if (healthNeverResponds) return;
            response.statusCode = 200;
            if (healthRequests <= healthFailuresBeforeReady) {
                response.setHeader('Content-Type', 'text/html; charset=utf-8');
                response.end('<html><body>Paws</body></html>');
            } else {
                response.setHeader('Content-Type', healthContentType);
                response.end(healthBody);
            }
            return;
        }
        response.statusCode = 200;
        response.setHeader('Content-Type', request.url?.endsWith('.wasm') ? 'application/wasm' : 'application/json');
        response.setHeader('Cache-Control', 'no-cache');
        response.end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;

    try {
        const result = await new Promise((resolve) => {
            const args = [verifierPath, origin, join(directory, 'index.html')];
            if (mode === 'immutable') args.push('--immutable', origin);
            const child = spawn(process.execPath, args, {
                env: {
                    ...process.env,
                    PAWS_WEB_HEALTH_RETRY_INTERVAL_MS: '10',
                    PAWS_WEB_HEALTH_TIMEOUT_MS: '100',
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            const killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
            child.stdout.on('data', (chunk) => { stdout += chunk; });
            child.stderr.on('data', (chunk) => { stderr += chunk; });
            child.on('close', (status) => {
                clearTimeout(killTimer);
                resolve({ status, stdout, stderr });
            });
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
    assert.match(result.stdout, /representative image asset/);
    assert.match(result.stdout, new RegExp(revision));
});

test('waits for a transient SPA health fallback while Caddy reload finishes', async () => {
    const result = await runVerifier({ healthFailuresBeforeReady: 1 });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /healthy happy-server JSON/i);
});

test('enforces the health readiness deadline when a request never responds', async () => {
    const startedAt = Date.now();
    const result = await runVerifier({ healthNeverResponds: true });

    assert.notEqual(result.status, 0);
    assert.ok(Date.now() - startedAt < 1_000, 'health verifier exceeded its hard deadline');
    assert.match(result.stderr, /health endpoint.*within 100ms/i);
});

test('rejects an HTML SPA fallback at the backend health endpoint', async () => {
    const result = await runVerifier({
        healthBody: '<html><body>Paws</body></html>',
        healthContentType: 'text/html; charset=utf-8',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /health endpoint.*application\/json/i);
});

test('rejects JSON that does not identify a healthy happy-server backend', async () => {
    const result = await runVerifier({ healthBody: JSON.stringify({ status: 'ok' }) });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /healthy happy-server response/i);
});

test('rejects an immutable release asset with the wrong MIME type before activation', async () => {
    const result = await runVerifier({ mode: 'immutable', scriptContentType: 'text/html; charset=utf-8' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /MIME type/i);
});

test('rejects an immutable entry without immutable cache headers before activation', async () => {
    const result = await runVerifier({ mode: 'immutable', immutableCache: false });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cache-control/i);
});

test('accepts a complete immutable release before activation', async () => {
    const result = await runVerifier({ mode: 'immutable' });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /immutable release entry/i);
    assert.match(result.stdout, /\.well-known\/assetlinks\.json/);
});
