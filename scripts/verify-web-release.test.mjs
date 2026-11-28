import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
const secondaryOrigin = 'https://121.43.32.242:8443';
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
    unownedSecondaryRoutes = false,
    unownedShareRoute = false,
    omitUnrelatedLocalAssets = false,
    includeAppCss = false,
    styleContentType = 'text/css',
    entryContentType = 'text/html; charset=utf-8',
    entryCacheControl = 'no-store',
    spaCacheControl = entryCacheControl,
    includeEntryScript = true,
    includeAppModule = false,
    moduleContentType = 'application/javascript',
    includeWebFont = false,
    webFontContentType = 'font/woff',
    webFontCors = true,
} = {}) {
    const directory = await createDist(includeSkin, includeWarmSkin);
    if (omitUnrelatedLocalAssets) await Promise.all(['desktop-skins', 'assets/sounds', '.well-known', 'metadata.json', 'canvaskit.wasm']
        .map(path => rm(join(directory, path), { recursive: true, force: true })));
    const botsJs = '/assets/bots/bots-' + 'b'.repeat(20) + '.js';
    const botsCss = '/assets/bots/bots-' + 'c'.repeat(20) + '.css';
    let html = await readFile(join(directory, 'index.html'), 'utf8');
    if (!includeEntryScript) html = html.replace('<script src="/_expo/app.js"></script>', '');
    if (includeAppCss) {
        html = html.replace('</head>', '<link rel="stylesheet" href="/_expo/app.css"></head>');
        await writeFile(join(directory, '_expo', 'app.css'), '.app { display: block; }');
    }
    if (includeAppModule) {
        html = html.replace('</head>', '<script type="module" src="/_expo/app.mjs"></script></head>');
        await writeFile(join(directory, '_expo', 'app.mjs'), 'export const app = true;');
    }
    if (includeWebFont) {
        html = html.replace('</head>', '<link rel="preload" as="font" href="/assets/fixture.woff"></head>');
        await writeFile(join(directory, 'assets', 'fixture.woff'), 'font');
    }
    const canvasMeta = includeCanvas && canvasFailure !== 'unconfigured'
        ? `<meta name="paws-project-canvas-entry" content="${canvasFailure === 'malformed-entry' ? '/dsh-image-canvas/invalid/index.html' : canvasPath}">` : '';
    await writeFile(join(directory, 'index.html'), html.replace('</head>', `<meta name="paws-bots-entry" content="${botsJs}"><meta name="paws-bots-style" content="${botsCss}">${canvasMeta}</head>`));
    if (includeCanvas) {
        for (const file of canvasFiles.keys()) {
            const target = join(directory, 'dsh-image-canvas', file);
            await mkdir(join(target, '..'), { recursive: true });
            await writeFile(target, `canvas fixture ${file}`);
        }
    }
    let healthRequests = 0;
    const requests = [];
    const server = http.createServer(async (request, response) => {
        requests.push(request.url);
        const origin = mode === 'secondary-canvas' ? secondaryOrigin : `http://127.0.0.1:${server.address().port}`;
        if (unownedSecondaryRoutes && request.url?.startsWith('/.well-known/')) {
            response.writeHead(200, { 'Content-Type': 'text/html' });
            response.end('<html>unrelated SPA fallback</html>');
            return;
        }
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
            response.setHeader('Cache-Control', canvasFailure === 'cache' ? 'no-cache' : 'public,max-age=31536000,immutable');
            response.setHeader('X-Content-Type-Options', 'nosniff');
            if (canvasFailure !== 'frame-header') response.setHeader('X-Frame-Options', 'SAMEORIGIN');
            response.end(file === 'canvas.css' && canvasFailure === 'bytes' ? 'different css' : `canvas fixture ${file}`);
            return;
        }
        if (request.url?.endsWith('.ttf') || request.url?.endsWith('.woff')) {
            if (assetNeverResponds) return;
            response.statusCode = 200;
            const webFont = request.url.endsWith('.woff');
            response.setHeader('Content-Type', webFont ? webFontContentType : 'font/ttf');
            if (includeFontCors && (!webFont || webFontCors) && request.headers.origin === origin) response.setHeader('Access-Control-Allow-Origin', origin);
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
            response.setHeader('Content-Type', entryContentType);
            if (!request.url?.startsWith('/share/')) {
                const cacheControl = request.url === '/' ? entryCacheControl : spaCacheControl;
                if (cacheControl !== null) response.setHeader('Cache-Control', cacheControl);
            }
            if (request.url?.startsWith('/share/') && !unownedSecondaryRoutes && !unownedShareRoute) {
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
        if (request.url === '/_expo/app.mjs') {
            response.writeHead(200, { 'Content-Type': moduleContentType, 'Cache-Control': 'public,max-age=31536000,immutable' });
            response.end('export const app = true;');
            return;
        }
        if (request.url === '/_expo/app.css') {
            response.writeHead(200, { 'Content-Type': styleContentType, 'Cache-Control': 'public,max-age=31536000,immutable' });
            response.end('.app { display: block; }');
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
        const fetchShim = join(directory, 'secondary-fetch-shim.mjs');
        if (mode === 'secondary-canvas') await writeFile(fetchShim, `
            const nativeFetch = globalThis.fetch;
            globalThis.fetch = (input, init) => {
                const url = new URL(input);
                if (url.origin !== ${JSON.stringify(secondaryOrigin)}) throw new Error('Unexpected secondary request origin');
                return nativeFetch(new URL(url.pathname + url.search, ${JSON.stringify(origin)}), init);
            };
        `);
        const result = await new Promise((resolve) => {
            const args = mode === 'secondary-canvas' ? ['--import', fetchShim, verifierPath, secondaryOrigin, join(directory, 'index.html'), '--secondary-canvas']
                : [verifierPath, origin, join(directory, 'index.html')];
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
        return { ...result, requests };
    } finally {
        await new Promise((resolve) => legacyServer.close(resolve));
        await new Promise((resolve) => server.close(resolve));
        await rm(directory, { recursive: true, force: true });
    }
}

test('live root and SPA HTML reject absent, fresh, or field-qualified cache policies', async () => {
    for (const mode of ['live', 'secondary-canvas']) {
        for (const field of ['entryCacheControl', 'spaCacheControl']) {
            for (const cacheControl of [null, 'public,max-age=3600', 'no-cache="Set-Cookie"']) {
                const result = await runVerifier({ mode, includeCanvas: true, [field]: cacheControl });
                assert.notEqual(result.status, 0, `${mode} ${field} ${cacheControl}`);
                assert.match(result.stderr, /(?:Web entry|SPA route) HTML cache-control permits stale reuse/);
            }
        }
    }
});

test('live HTML accepts no-store or unqualified full-response revalidation', async () => {
    for (const mode of ['live', 'secondary-canvas']) {
        for (const cacheControl of ['no-store', 'private, no-cache', String.raw`private="X-Foo\", X-Bar", no-cache`]) {
            const result = await runVerifier({ mode, includeCanvas: true, entryCacheControl: cacheControl });
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /Web entry HTML cache-control/);
            assert.match(result.stdout, /SPA route HTML cache-control/);
        }
    }
});

for (const mode of ['live', 'secondary-canvas']) {
    for (const [label, cacheControl] of [
        ['quoted no-cache field', 'no-cache="Set-Cookie, no-cache, ETag"'],
        ['quoted no-store field', 'private="X-Foo, no-store, X-Bar", max-age=3600'],
        ['escaped quote inside a field list', String.raw`private="X-Foo\", no-store, X-Bar", max-age=3600`],
        ['unclosed quoted string', 'no-store, private="X-Foo'],
        ['unfinished quoted escape', 'no-cache, private="X-Foo' + '\\'],
    ]) {
        test(`${mode} HTML rejects ${label} as a full-response cache policy`, async () => {
            for (const field of ['entryCacheControl', 'spaCacheControl']) {
                const result = await runVerifier({ mode, includeCanvas: true, [field]: cacheControl });
                assert.notEqual(result.status, 0, `${field} ${cacheControl}`);
                assert.match(result.stderr, /(?:Web entry|SPA route) HTML cache-control permits stale reuse/);
            }
        });
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


test('secondary canvas mode verifies the scoped release without claiming association or share route ownership', async () => {
    const result = await runVerifier({ mode: 'secondary-canvas', includeCanvas: true, includeAppCss: true, includeAppModule: true, includeWebFont: true, unownedSecondaryRoutes: true, omitUnrelatedLocalAssets: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /secondary canvas release.*verified/i);
    for (const path of ['/health', '/', '/session/web-deploy-check', '/_expo/app.js', '/_expo/app.css', '/_expo/app.mjs', '/assets/fixture.woff',
        '/assets/Ionicons.abc123.ttf', '/assets/Octicons.def456.ttf', canvasPath]) assert.ok(result.requests.includes(path), path);
    assert.equal(result.requests.some(path => path.startsWith('/.well-known/') || path.startsWith('/share/')
        || path.startsWith('/desktop-skins/') || path.startsWith('/assets/bots/') || path.endsWith('.wav')), false);
});

test('the full verifier retains association-route checks for the same secondary-like fixture', async () => {
    for (const mode of ['live', 'immutable']) {
        const result = await runVerifier({ includeCanvas: true, mode, unownedSecondaryRoutes: true });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /apple-app-site-association returned an invalid MIME type: text\/html/);
    }
});

test('secondary canvas mode still rejects invalid renderer bytes, MIME, redirects, cache and protections', async () => {
    for (const canvasFailure of ['redirect', 'mime', 'bytes', 'missing', 'entry', 'malformed-entry', 'unconfigured', 'frame-header', 'cache']) {
        const result = await runVerifier({ mode: 'secondary-canvas', includeCanvas: true, unownedSecondaryRoutes: true, canvasFailure });
        assert.notEqual(result.status, 0, canvasFailure);
        assert.match(result.stderr, /Project Canvas/i, canvasFailure);
    }
});

test('secondary canvas mode requires the renderer and healthy app entry assets', async () => {
    for (const fixture of [
        { includeCanvas: false, expected: /requires.*Project Canvas renderer/i },
        { includeCanvas: true, includeEntryScript: false, expected: /requires.*app.*JavaScript entry/i },
        { includeCanvas: true, entryContentType: 'text/plain', expected: /Web entry.*invalid MIME type/i },
        { includeCanvas: true, scriptContentType: 'text/html', expected: /app.js.*invalid MIME type/i },
        { includeCanvas: true, includeAppCss: true, styleContentType: 'text/html', expected: /app.css.*invalid MIME type/i },
        { includeCanvas: true, includeFontCors: false, expected: /Access-Control-Allow-Origin/i },
        { includeCanvas: true, liveRevision: 'a'.repeat(40), expected: /release revision mismatch/i },
        { includeCanvas: true, healthBody: JSON.stringify({ status: 'not-ok' }), expected: /healthy happy-server/i },
    ]) {
        const { expected, ...options } = fixture;
        const result = await runVerifier({ mode: 'secondary-canvas', unownedSecondaryRoutes: true, ...options });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, expected);
    }
});

test('secondary canvas mode cannot weaken verification for any other origin', () => {
    for (const origin of ['https://47.115.228.20:8443', 'http://121.43.32.242:8443', 'https://121.43.32.242:8444',
        'https://121.43.32.242', 'https://121.43.32.242:8443/', 'https://121.43.32.242.evil.example:8443']) {
        const result = spawnSync(process.execPath, [verifierPath, origin, '/unused/index.html', '--secondary-canvas'], { encoding: 'utf8' });
        assert.notEqual(result.status, 0, origin);
        assert.match(result.stderr, /secondary canvas verification requires the exact approved origin/i, origin);
    }
});


test('the full live verifier retains public-share protection checks', async () => {
    const result = await runVerifier({ includeCanvas: true, unownedShareRoute: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /public share header cache-control missing/i);
});


for (const { name, expected, ...options } of [
    { name: 'module HTML fallback', includeAppModule: true, moduleContentType: 'text/html', expected: /app.mjs.*invalid MIME type/i },
    { name: 'WOFF HTML fallback', includeWebFont: true, webFontContentType: 'text/html', expected: /fixture.woff.*invalid MIME type/i },
    { name: 'WOFF without browser CORS', includeWebFont: true, webFontCors: false, expected: /fixture.woff Access-Control-Allow-Origin/i },
]) {
    test(`secondary canvas rejects declared app ${name}`, async () => {
        const result = await runVerifier({ mode: 'secondary-canvas', includeCanvas: true, unownedSecondaryRoutes: true, ...options });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, expected);
    });
}
