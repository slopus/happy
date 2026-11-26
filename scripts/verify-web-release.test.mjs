import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const verifierPath = fileURLToPath(new URL('./verify-web-release.mjs', import.meta.url));
const assetManifest = JSON.parse(await readFile(fileURLToPath(new URL('./desktop-skin-assets.json', import.meta.url)), 'utf8'));
const sourceSkins = fileURLToPath(new URL('../packages/happy-app/public/desktop-skins/', import.meta.url));
const revision = '1234567890abcdef1234567890abcdef12345678';
const canvasPath = `/dsh-image-canvas/${revision}/index.html`;
const canvasFiles = new Map([
    ['index.html', 'text/html'],
    ['canvas.js', 'application/javascript'],
    ['canvas.css', 'text/css'],
    ['upstream-build.json', 'application/json'],
    ['NOTICE.txt', 'text/plain'],
    ['DSH-Image-Gen-LICENSE.txt', 'text/plain'],
    ['tldraw-LICENSE.md', 'text/plain'],
    ['assets/fonts/Shantell_Sans-Informal_Regular.woff2', 'font/woff2'],
    ['assets/icons/icon/0_merged.svg', 'image/svg+xml'],
    ['assets/translations/en.json', 'application/json'],
    ['assets/translations/zh-cn.json', 'application/json'],
]);

async function createDist(includeSkin = true, includeWarmSkin = true) {
    const directory = await mkdtemp(join(tmpdir(), 'paws-web-verify-'));
    await mkdir(join(directory, 'assets'), { recursive: true });
    await mkdir(join(directory, 'assets', 'sounds', 'codeisland'), { recursive: true });
    await mkdir(join(directory, '_expo'), { recursive: true });
    await mkdir(join(directory, '.well-known'), { recursive: true });
    if (includeSkin) {
        for (const skin of assetManifest.skins) {
            if (!includeWarmSkin && skin.assetId === 'warm-night') continue;
            await mkdir(join(directory, 'desktop-skins', skin.assetId), { recursive: true });
            await copyFile(join(sourceSkins, skin.assetId, skin.filename), join(directory, 'desktop-skins', skin.assetId, skin.filename));
        }
    }
    await writeFile(join(directory, 'index.html'), '<html><head></head><body><script src="/_expo/app.js"></script></body></html>');
    await writeFile(join(directory, '.paws-release-revision'), `${revision}\n`);
    await writeFile(join(directory, 'assets', 'Ionicons.abc123.ttf'), 'ionicons');
    await writeFile(join(directory, 'assets', 'Octicons.def456.ttf'), 'octicons');
    await writeFile(join(directory, 'assets', 'fixture.abc123.png'), 'image');
    for (const name of ['approval', 'complete', 'error', 'start', 'submit']) {
        await writeFile(join(directory, 'assets', 'sounds', 'codeisland', `8bit_${name}.wav`), 'RIFF');
    }
    await writeFile(join(directory, '_expo', 'app.js'), 'app');
    await writeFile(join(directory, 'metadata.json'), '{}');
    await writeFile(join(directory, 'canvaskit.wasm'), 'wasm');
    await writeFile(join(directory, '.well-known', 'apple-app-site-association'), '{}');
    await writeFile(join(directory, '.well-known', 'assetlinks.json'), '[]');
    return directory;
}

test('verifies exact enabled canvas bytes before activation and on the same-origin route', async () => {
    for (const mode of ['immutable', 'live']) {
        const result = await runVerifier({ includeCanvas: true, mode });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /OK Project Canvas assets are pinned to [a-f0-9]{40}/);
    }
});

test('rejects enabled canvas redirects, wrong MIME, stale bytes, missing files, and wrong entry metadata', async () => {
    for (const [canvasFailure, expected] of [
        ['redirect', /Project Canvas canvas.js failed with HTTP 302/],
        ['mime', /Project Canvas canvas.js returned an invalid MIME type/],
        ['bytes', /Project Canvas canvas.css content mismatch/],
        ['missing', /Project Canvas canvas.css failed with HTTP 404/],
        ['entry', /Web entry Project Canvas entry mismatch/],
        ['unconfigured', /Project Canvas renderer and release entry must be included together/],
        ['frame-header', /Project Canvas \S+ is missing same-origin proxy protections/],
    ]) {
        const result = await runVerifier({ includeCanvas: true, canvasFailure });
        assert.notEqual(result.status, 0, canvasFailure);
        assert.match(result.stderr, expected);
    }
});

async function runVerifier({
    healthBody = JSON.stringify({ status: 'ok', service: 'happy-server' }),
    healthContentType = 'application/json; charset=utf-8',
    healthFailuresBeforeReady = 0,
    healthNeverResponds = false,
    liveRevision = revision,
    includeFontCors = true,
    mode = 'live',
    scriptContentType = 'application/javascript; charset=utf-8',
    audioContentType = 'audio/vnd.wave',
    htmlAudioName = null,
    htmlAudioBodyName = null,
    immutableCache = true,
    legacyRedirectLocation = 'canonical',
    legacyRedirectStatus = 308,
    healthTimeoutMs = 300,
    requestTimeoutMs = 1500,
    assetNeverResponds = false,
    entryNeverResponds = false,
    skinCacheImmutable = true,
    skinContentMatches = true,
    includeSkin = true,
    includeWarmSkin = true,
    botsAssetFailure = null,
    includeCanvas = false,
    canvasFailure = null,
} = {}) {
    const directory = await createDist(includeSkin, includeWarmSkin);
    const botsJs = '/assets/bots/bots-' + 'b'.repeat(20) + '.js';
    const botsCss = '/assets/bots/bots-' + 'c'.repeat(20) + '.css';
    const html = await readFile(join(directory, 'index.html'), 'utf8');
    const canvasMeta = includeCanvas && canvasFailure !== 'unconfigured'
        ? `<meta name="paws-project-canvas-entry" content="${canvasPath}">` : '';
    await writeFile(join(directory, 'index.html'), html.replace('</head>', `<meta name="paws-bots-entry" content="${botsJs}"><meta name="paws-bots-style" content="${botsCss}">${canvasMeta}</head>`));
    if (includeCanvas) {
        for (const file of canvasFiles.keys()) {
            const target = join(directory, 'dsh-image-canvas', file);
            await mkdir(join(target, '..'), { recursive: true });
            await writeFile(target, `canvas fixture ${file}`);
        }
    }
    let healthRequests = 0;
    const server = http.createServer(async (request, response) => {
        const origin = `http://127.0.0.1:${server.address().port}`;
        const canvasPrefix = mode === 'immutable' ? `/web/releases/${revision}/dsh-image-canvas/` : `/dsh-image-canvas/${revision}/`;
        if (includeCanvas && request.url?.startsWith(canvasPrefix)) {
            const file = request.url.slice(canvasPrefix.length);
            const type = canvasFiles.get(file);
            if (file === 'canvas.js' && canvasFailure === 'redirect') {
                response.writeHead(302, { Location: '/_expo/app.js' });
                response.end();
                return;
            }
            response.statusCode = type && !(file === 'canvas.css' && canvasFailure === 'missing') ? 200 : 404;
            response.setHeader('Content-Type', file === 'canvas.js' && canvasFailure === 'mime' ? 'text/html' : type || 'text/plain');
            response.setHeader('Cache-Control', 'public,max-age=31536000,immutable');
            response.setHeader('X-Content-Type-Options', 'nosniff');
            if (canvasFailure !== 'frame-header') response.setHeader('X-Frame-Options', 'SAMEORIGIN');
            response.end(file === 'canvas.css' && canvasFailure === 'bytes' ? 'different css' : `canvas fixture ${file}`);
            return;
        }
        if (request.url?.endsWith('.ttf')) {
            if (assetNeverResponds) return;
            response.statusCode = 200;
            response.setHeader('Content-Type', 'font/ttf');
            if (includeFontCors) response.setHeader('Access-Control-Allow-Origin', origin);
            response.setHeader('Cache-Control', 'public,max-age=31536000,immutable');
            response.end('font');
            return;
        }
        if (request.url?.endsWith('.png') || request.url?.endsWith('.webp')) {
            response.statusCode = 200;
            response.setHeader('Content-Type', request.url?.endsWith('.webp') ? 'image/webp' : 'image/png');
            response.setHeader('Cache-Control', request.url?.startsWith('/desktop-skins/') && !skinCacheImmutable ? 'no-cache' : 'public,max-age=31536000,immutable');
            response.end(request.url?.startsWith('/desktop-skins/')
                ? skinContentMatches ? await readFile(join(directory, request.url)) : 'changed'
                : 'image');
            return;
        }
        if (request.url?.endsWith('.wav')) {
            response.statusCode = 200;
            response.setHeader('Content-Type', htmlAudioName && request.url.endsWith(`8bit_${htmlAudioName}.wav`)
                ? 'text/html; charset=utf-8' : audioContentType);
            response.setHeader('Cache-Control', 'public,max-age=31536000,immutable');
            response.end(htmlAudioBodyName && request.url.endsWith(`8bit_${htmlAudioBodyName}.wav`)
                ? '<html>fallback</html>' : 'RIFF');
            return;
        }
        if (request.url === `/web/releases/${revision}/index.html`) {
            response.statusCode = 200;
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.setHeader('Cache-Control', immutableCache ? 'public,max-age=31536000,immutable' : 'no-cache');
            response.end(`<html><head><meta name="paws-release-revision" content="${liveRevision}">${canvasMeta}</head></html>`);
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
            if (entryNeverResponds && request.url === '/') return;
            response.statusCode = 200;
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            if (request.url?.startsWith('/share/')) {
                response.setHeader('Cache-Control', 'no-store');
                response.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
                response.setHeader('X-Content-Type-Options', 'nosniff');
                response.setHeader('Referrer-Policy', 'no-referrer');
                response.setHeader('Content-Security-Policy', "default-src 'self'");
            }
            response.end(`<html><head><meta name="paws-release-revision" content="${liveRevision}">${canvasFailure === 'entry' ? '' : canvasMeta}</head></html>`);
            return;
        }
        if (request.url === botsJs || request.url === botsCss) {
            response.statusCode = botsAssetFailure === 'missing' ? 404 : 200;
            response.setHeader('Content-Type', botsAssetFailure === 'html' ? 'text/html' : request.url.endsWith('.css') ? 'text/css' : 'application/javascript');
            response.setHeader('Cache-Control', 'public,max-age=31536000,immutable');
            response.end('bots source build'); return;
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
    const legacyServer = http.createServer((request, response) => {
        response.statusCode = legacyRedirectStatus;
        if (legacyRedirectLocation) {
            response.setHeader(
                'Location',
                legacyRedirectLocation === 'canonical' ? `${origin}${request.url}` : legacyRedirectLocation,
            );
        }
        response.end();
    });
    await new Promise((resolve) => legacyServer.listen(0, '127.0.0.1', resolve));
    const legacyOrigin = `http://127.0.0.1:${legacyServer.address().port}`;

    try {
        const result = await new Promise((resolve) => {
            const args = [verifierPath, origin, join(directory, 'index.html')];
            if (mode === 'immutable') args.push('--immutable', origin);
            const child = spawn(process.execPath, args, {
                env: {
                    ...process.env,
                    PAWS_WEB_HEALTH_RETRY_INTERVAL_MS: '10',
                    PAWS_WEB_HEALTH_TIMEOUT_MS: String(healthTimeoutMs),
                    PAWS_WEB_REQUEST_TIMEOUT_MS: String(requestTimeoutMs),
                    PAWS_LEGACY_WEB_ORIGIN: legacyOrigin,
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            const killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
            child.stdout.on('data', (chunk) => { stdout += chunk; });
            child.stderr.on('data', (chunk) => { stderr += chunk; });
            child.on('close', (status) => {
                clearTimeout(killTimer);
                resolve({ status, stdout, stderr });
            });
        });
        return result;
    } finally {
        await new Promise((resolve) => legacyServer.close(resolve));
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
    assert.match(result.stdout, /desktop skin background/);
    assert.match(result.stdout, new RegExp(revision));
    assert.match(result.stdout, /legacy Web entry redirects to the canonical origin/i);
});

test('rejects a mutable DreamSkin background that would survive rollback', async () => {
    const result = await runVerifier({ skinCacheImmutable: false });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /desktop skin background.*immutable/i);
});

test('rejects a remote DreamSkin image with different bytes under the same immutable URL', async () => {
    const result = await runVerifier({ skinContentMatches: false });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /desktop skin background.*SHA-256/i);
});

test('rejects a DreamSkin Web release missing its background', async () => {
    const result = await runVerifier({ includeSkin: false });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /desktop skin background.*missing/i);
});

test('rejects a Web release missing the second desktop skin', async () => {
    const result = await runVerifier({ includeWarmSkin: false });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /desktop skin background.*missing/i);
});

test('rejects a legacy Web entry that still serves content instead of redirecting', async () => {
    const result = await runVerifier({ legacyRedirectStatus: 200, legacyRedirectLocation: null });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /legacy Web entry.*HTTP 308/i);
});

test('rejects a legacy Web entry that redirects away from the canonical origin', async () => {
    const result = await runVerifier({ legacyRedirectLocation: 'https://example.com/share/public-deployment-probe' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /legacy Web entry.*canonical/i);
});

test('waits for a transient SPA health fallback while Caddy reload finishes', async () => {
    const result = await runVerifier({ healthFailuresBeforeReady: 1 });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /healthy happy-server JSON/i);
});

test('enforces the health readiness deadline when a request never responds', async () => {
    const startedAt = Date.now();
    const result = await runVerifier({ healthNeverResponds: true, healthTimeoutMs: 100 });

    assert.notEqual(result.status, 0);
    assert.ok(Date.now() - startedAt < 3_000, 'health verifier exceeded its hard deadline');
    assert.match(result.stderr, /health endpoint.*within 100ms/i);
});

test('bounds a Web asset request that never responds', async () => {
    const startedAt = Date.now();
    const result = await runVerifier({ assetNeverResponds: true, requestTimeoutMs: 100 });

    assert.notEqual(result.status, 0);
    assert.ok(Date.now() - startedAt < 3_000, 'asset verifier exceeded its hard deadline');
    assert.match(result.stderr, /timeout|aborted/i);
});

test('bounds a canonical Web entry request that never responds', async () => {
    const startedAt = Date.now();
    const result = await runVerifier({ entryNeverResponds: true, requestTimeoutMs: 100 });

    assert.notEqual(result.status, 0);
    assert.ok(Date.now() - startedAt < 3_000, 'entry verifier exceeded its hard deadline');
    assert.match(result.stderr, /timeout|aborted/i);
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

test('rejects an audio asset that resolves to the SPA HTML fallback', async () => {
    const result = await runVerifier({ audioContentType: 'text/html; charset=utf-8', requestTimeoutMs: 1500 });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /audio asset.*MIME type/i);
});

test('rejects an HTML fallback for a non-completion sound', async () => {
    const result = await runVerifier({ htmlAudioName: 'submit', requestTimeoutMs: 1500 });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /audio asset.*8bit_submit\.wav.*MIME type/i);
});

test('rejects HTML mislabeled with an audio MIME type', async () => {
    const result = await runVerifier({ htmlAudioBodyName: 'error', requestTimeoutMs: 1500 });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /audio asset.*8bit_error\.wav.*content mismatch/i);
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


test('verifies lazy Bots JS and CSS declared in release metadata', async () => {
    const result = await runVerifier();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /assets\/bots\/bots-b+\.js/);
    assert.match(result.stdout, /assets\/bots\/bots-c+\.css/);
});
test('refuses activation when a lazy Bots asset is absent or falls back to HTML', async () => {
    for (const failure of ['missing', 'html']) {
        const result = await runVerifier({ botsAssetFailure: failure });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /assets\/bots|invalid MIME/);
    }
});
