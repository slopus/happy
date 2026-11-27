import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const [origin, indexPath, mode, browserOriginArgument] = process.argv.slice(2);

if (!origin || !indexPath) {
    throw new Error('Usage: node scripts/verify-web-release.mjs <origin> <index.html> [--immutable <browser-origin>|--secondary-canvas]');
}
if (mode && !['--immutable', '--secondary-canvas'].includes(mode)) throw new Error(`unknown verification mode: ${mode}`);
const secondaryCanvasMode = mode === '--secondary-canvas';
if (secondaryCanvasMode && origin !== 'https://121.43.32.242:8443') {
    throw new Error('Secondary canvas verification requires the exact approved origin https://121.43.32.242:8443.');
}
if (secondaryCanvasMode && process.argv.slice(2).length !== 3) throw new Error('--secondary-canvas accepts no additional origin or options.');
if (mode === '--immutable' && !browserOriginArgument) throw new Error('--immutable requires the browser origin used for CORS');

const normalizedOrigin = origin.replace(/\/+$/, '');
const immutableMode = mode === '--immutable';
const browserOrigin = immutableMode ? browserOriginArgument.replace(/\/+$/, '') : normalizedOrigin;
const resolvedIndexPath = resolve(indexPath);
const distDirectory = dirname(resolvedIndexPath);
const html = await readFile(resolvedIndexPath, 'utf8');
const expectedRevision = (await readFile(join(distDirectory, '.paws-release-revision'), 'utf8')).trim();
if (!/^[0-9a-f]{40}$/.test(expectedRevision)) {
    throw new Error(`invalid local release revision: ${JSON.stringify(expectedRevision)}`);
}
const canvasEntry = projectCanvasEntry(html);
const canvasDirectory = await stat(join(distDirectory, 'dsh-image-canvas')).catch(error => {
    if (error.code !== 'ENOENT') throw error;
});
if (Boolean(canvasDirectory?.isDirectory()) !== Boolean(canvasEntry)) {
    throw new Error('The Project Canvas renderer and release entry must be included together.');
}
if (secondaryCanvasMode && !canvasEntry) throw new Error('Secondary canvas verification requires an enabled Project Canvas renderer.');
const references = new Set();
const attributePattern = /(?:src|href)=["']([^"']+)["']/gi;

for (const match of html.matchAll(attributePattern)) {
    const reference = match[1];
    if (reference.startsWith('/') && !reference.startsWith('//')
        && (!secondaryCanvasMode || /\.(?:[cm]?js|css|ttf|woff2?|otf)$/i.test(new URL(reference, normalizedOrigin).pathname))) {
        references.add(reference);
    }
}

if (secondaryCanvasMode && ![...references].some(reference => /\.[cm]?js$/i.test(new URL(reference, normalizedOrigin).pathname))) {
    throw new Error('Secondary canvas verification requires a declared app JavaScript entry.');
}

if (!secondaryCanvasMode) {
    // Bots is loaded on demand from immutable metadata, not a script tag in the
    // initial document. Verify both assets before activating this release as well.
    const botsReferences = [...html.matchAll(/<meta\s+name=["']paws-bots-(entry|style)["']\s+content=["']([^"']+)["'][^>]*>/gi)];
    if (botsReferences.length) {
        if (botsReferences.length !== 2 || new Set(botsReferences.map(match => match[1])).size !== 2) throw new Error('incomplete Bots asset metadata');
        for (const match of botsReferences) {
            const extension = match[1] === 'entry' ? 'js' : 'css';
            if (!new RegExp(`^/assets/bots/bots-[a-f0-9]{20}\\.${extension}$`).test(match[2])) throw new Error('invalid immutable Bots asset path');
            references.add(match[2]);
        }
    }

    for (const requiredPath of [
        '/metadata.json',
        '/canvaskit.wasm',
        '/.well-known/apple-app-site-association',
        '/.well-known/assetlinks.json',
    ]) {
        references.add(requiredPath);
    }
}

async function fetchRequired(label, url, init) {
    const response = await fetch(url, {
        redirect: 'follow',
        ...init,
        signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}: ${url}`);
    console.log(`OK ${response.status} ${label}`);
    return response;
}

function projectCanvasEntry(body) {
    const entries = [...body.matchAll(/<meta\s+name=["']paws-project-canvas-entry["']\s+content=["']([^"']+)["'][^>]*>/gi)];
    if (entries.length === 0) return undefined;
    const expected = `/dsh-image-canvas/${expectedRevision}/index.html`;
    if (entries.length !== 1 || entries[0][1] !== expected) {
        throw new Error(`invalid Project Canvas release entry: expected one ${expected}`);
    }
    return expected;
}

async function verifyProjectCanvas() {
    if (!canvasEntry) return;
    const area = 'dsh-image-canvas';
    const prefix = immutableMode ? `/web/releases/${expectedRevision}/${area}/` : canvasEntry.slice(0, -'index.html'.length);
    const files = [
        'index.html',
        'canvas.js',
        'canvas.css',
        'upstream-build.json',
        'NOTICE.txt',
        'DSH-Image-Gen-LICENSE.txt',
        'tldraw-LICENSE.md',
        'assets/fonts/Shantell_Sans-Informal_Regular.woff2',
        'assets/icons/icon/0_merged.svg',
        'assets/translations/en.json',
        'assets/translations/zh-cn.json',
    ];
    await Promise.all(files.map(async file => {
        const path = prefix + file;
        const label = `Project Canvas ${file}`;
        const [expected, response] = await Promise.all([
            readFile(join(distDirectory, area, file)),
            fetchRequired(label, normalizedOrigin + path, { redirect: 'manual' }),
        ]);
        assertMime(label, path, response);
        assertCachePolicy(label, path, response);
        if (!expected.equals(Buffer.from(await response.arrayBuffer()))) throw new Error(`${label} content mismatch`);
        if (!immutableMode) {
            if (response.headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff'
                || response.headers.get('x-frame-options')?.toUpperCase() !== 'SAMEORIGIN'
                || response.headers.has('content-disposition') || response.headers.has('set-cookie')) {
                throw new Error(`${label} is missing same-origin proxy protections`);
            }
        }
    }));
    console.log(`OK Project Canvas assets are pinned to ${expectedRevision}`);
}

function positiveDuration(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
    return value;
}

const healthTimeoutMs = positiveDuration('PAWS_WEB_HEALTH_TIMEOUT_MS', 30_000);
const healthRetryIntervalMs = positiveDuration('PAWS_WEB_HEALTH_RETRY_INTERVAL_MS', 1_000);
const requestTimeoutMs = positiveDuration('PAWS_WEB_REQUEST_TIMEOUT_MS', 30_000);
const legacyWebOrigin = process.env.PAWS_LEGACY_WEB_ORIGIN?.replace(/\/+$/, '') ?? null;

async function waitForHealthyServer() {
    const deadline = Date.now() + healthTimeoutMs;
    let lastError;
    do {
        try {
            const remainingMs = Math.max(1, deadline - Date.now());
            const response = await fetch(`${normalizedOrigin}/health`, {
                redirect: 'follow',
                signal: AbortSignal.timeout(remainingMs),
            });
            if (!response.ok) throw new Error(`health endpoint failed with HTTP ${response.status}: ${normalizedOrigin}/health`);
            const contentType = response.headers.get('content-type') ?? '';
            if (!/^application\/(?:[a-z0-9.+-]+\+)?json\b/i.test(contentType)) {
                throw new Error(`health endpoint must return application/json, got: ${contentType || '(missing)'}`);
            }
            const health = await response.json();
            if (health?.status !== 'ok' || health?.service !== 'happy-server') {
                throw new Error(`health endpoint did not return a healthy happy-server response: ${JSON.stringify(health)}`);
            }
            console.log('OK 200 health endpoint');
            console.log('OK health endpoint returned healthy happy-server JSON');
            return;
        } catch (error) {
            if (error?.name !== 'TimeoutError' || !lastError) lastError = error;
            if (Date.now() >= deadline) break;
            await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(healthRetryIntervalMs, deadline - Date.now())));
        }
    } while (Date.now() <= deadline);
    throw new Error(`health endpoint did not become ready within ${healthTimeoutMs}ms: ${lastError?.message ?? 'unknown error'}`, {
        cause: lastError,
    });
}

async function waitForLegacyWebRedirect() {
    if (!legacyWebOrigin) return;
    const probePath = '/share/public-deployment-probe';
    const expectedLocation = `${normalizedOrigin}${probePath}`;
    const deadline = Date.now() + healthTimeoutMs;
    let lastError;
    do {
        try {
            const remainingMs = Math.max(1, deadline - Date.now());
            const response = await fetch(`${legacyWebOrigin}${probePath}`, {
                redirect: 'manual',
                signal: AbortSignal.timeout(remainingMs),
            });
            if (response.status !== 308) {
                throw new Error(`legacy Web entry must return HTTP 308, got ${response.status}`);
            }
            const location = response.headers.get('location');
            const resolvedLocation = location ? new URL(location, legacyWebOrigin).href : null;
            if (resolvedLocation !== expectedLocation) {
                throw new Error(`legacy Web entry must redirect to the canonical origin: expected ${expectedLocation}, got ${resolvedLocation ?? '(missing)'}`);
            }
            console.log('OK legacy Web entry redirects to the canonical origin');
            return;
        } catch (error) {
            if (error?.name !== 'TimeoutError' || !lastError) lastError = error;
            if (Date.now() >= deadline) break;
            await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(healthRetryIntervalMs, deadline - Date.now())));
        }
    } while (Date.now() <= deadline);
    throw new Error(`legacy Web entry did not become a canonical redirect within ${healthTimeoutMs}ms: ${lastError?.message ?? 'unknown error'}`, {
        cause: lastError,
    });
}

function assertHtmlRevision(label, body) {
    const revisionPattern = /<meta\s+name=["']paws-release-revision["']\s+content=["']([0-9a-f]{40})["']\s*\/?\s*>/i;
    const actualRevision = body.match(revisionPattern)?.[1] ?? null;
    if (actualRevision !== expectedRevision) {
        throw new Error(`${label} release revision mismatch: expected ${expectedRevision}, got ${actualRevision ?? '(missing)'}`);
    }
    if (projectCanvasEntry(body) !== canvasEntry) throw new Error(`${label} Project Canvas entry mismatch`);
    console.log(`OK ${expectedRevision} ${label} release revision`);
}

function expectedMimePattern(pathname) {
    pathname = pathname.toLowerCase();
    if (pathname.endsWith('/apple-app-site-association') || pathname.endsWith('.json')) return /^application\/(?:[a-z0-9.+-]+\+)?json\b/i;
    if (/\.[cm]?js$/.test(pathname)) return /^(?:application|text)\/javascript\b/i;
    if (pathname.endsWith('.css')) return /^text\/css\b/i;
    if (pathname.endsWith('.wasm')) return /^application\/wasm\b/i;
    if (pathname.endsWith('.ttf')) return /^(?:font\/ttf|application\/(?:x-font-ttf|font-sfnt))\b/i;
    if (pathname.endsWith('.woff2')) return /^font\/woff2\b/i;
    if (pathname.endsWith('.woff')) return /^(?:font\/woff|application\/(?:font-woff|x-font-woff))\b/i;
    if (pathname.endsWith('.otf')) return /^(?:font\/otf|application\/vnd\.ms-opentype)\b/i;
    if (pathname.endsWith('.wav')) return /^audio\/(?:wav|wave|x-wav|vnd\.wave)\b/i;
    if (pathname.endsWith('.ico')) return /^image\/(?:x-icon|vnd\.microsoft\.icon)\b/i;
    if (pathname.endsWith('.svg')) return /^image\/svg\+xml\b/i;
    if (pathname.endsWith('.png')) return /^image\/png\b/i;
    if (/\.jpe?g$/i.test(pathname)) return /^image\/jpeg\b/i;
    if (pathname.endsWith('.gif')) return /^image\/gif\b/i;
    if (pathname.endsWith('.webp')) return /^image\/webp\b/i;
    if (pathname.endsWith('.html')) return /^text\/html\b/i;
    return null;
}

function assertMime(label, pathname, response) {
    const expected = expectedMimePattern(pathname);
    if (!expected) return;
    const contentType = response.headers.get('content-type') ?? '';
    if (!expected.test(contentType)) {
        throw new Error(`${label} returned an invalid MIME type: ${contentType || '(missing)'}`);
    }
    console.log(`OK ${contentType} ${label} MIME type`);
}

function assertCachePolicy(label, pathname, response) {
    const cacheControl = response.headers.get('cache-control') ?? '';
    const immutable = pathname.startsWith('/web/releases/') || pathname.startsWith('/_expo/') || pathname.startsWith('/assets/')
        || pathname.startsWith('/desktop-skins/') || pathname.startsWith(`/dsh-image-canvas/${expectedRevision}/`);
    if (immutable) {
        if (!/\bmax-age=31536000\b/i.test(cacheControl) || !/\bimmutable\b/i.test(cacheControl)) {
            throw new Error(`${label} cache-control is not immutable: ${cacheControl || '(missing)'}`);
        }
    } else if (!/\bno-cache\b/i.test(cacheControl)) {
        throw new Error(`${label} cache-control is not revalidated: ${cacheControl || '(missing)'}`);
    }
    console.log(`OK ${cacheControl} ${label} cache-control`);
}

async function listFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const entryPath = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await listFiles(entryPath));
        else if (entry.isFile()) files.push(entryPath);
    }
    return files;
}

function assetUrlForFile(filePath) {
    const relativePath = relative(distDirectory, filePath).split(sep).map(encodeURIComponent).join('/');
    return `${normalizedOrigin}/${relativePath}`;
}

function assertBrowserFontCors(label, response) {
    const allowedOrigin = response.headers.get('access-control-allow-origin') ?? '';
    if (allowedOrigin !== '*' && allowedOrigin !== browserOrigin) {
        throw new Error(`${label} Access-Control-Allow-Origin does not cover ${browserOrigin}: ${allowedOrigin || '(missing)'}`);
    }
}

const assetFiles = await listFiles(join(distDirectory, 'assets'));
for (const family of ['Ionicons', 'Octicons']) {
    const fontPath = assetFiles.find((filePath) => filePath.endsWith('.ttf') && filePath.includes(family));
    if (!fontPath) throw new Error(`required ${family} font not found in ${join(distDirectory, 'assets')}`);
    const response = await fetchRequired(family, assetUrlForFile(fontPath), {
        headers: { Origin: browserOrigin },
    });
    assertMime(family, fontPath, response);
    assertCachePolicy(family, assetUrlForFile(fontPath).slice(normalizedOrigin.length), response);
    assertBrowserFontCors(family, response);
}

// The secondary canvas does not own unrelated app feature assets or routes.
if (!secondaryCanvasMode) {
    const representativeImagePath = assetFiles.find((filePath) => /\.(?:png|jpe?g|gif|webp|svg)$/i.test(filePath));
    if (!representativeImagePath) throw new Error(`representative image asset not found in ${join(distDirectory, 'assets')}`);
    const representativeImageUrl = assetUrlForFile(representativeImagePath);
    const representativeImageResponse = await fetchRequired('representative image asset', representativeImageUrl);
    assertMime('representative image asset', representativeImagePath, representativeImageResponse);
    assertCachePolicy('representative image asset', representativeImageUrl.slice(normalizedOrigin.length), representativeImageResponse);

    const skinDirectory = join(distDirectory, 'desktop-skins');
    const skinFiles = await listFiles(skinDirectory).catch((error) => {
        if (error?.code === 'ENOENT') return [];
        throw error;
    });
    const skinManifest = JSON.parse(await readFile(fileURLToPath(new URL('./desktop-skin-assets.json', import.meta.url)), 'utf8'));
    const requiredSkins = new Map(skinManifest.skins.map((skin) => [skin.assetId, skin.filename]));
    if (skinManifest.schemaVersion !== 1 || requiredSkins.size !== skinManifest.skins.length || skinFiles.length !== requiredSkins.size) {
        throw new Error(`desktop skin background missing or ambiguous: found ${skinFiles.length}`);
    }
    const foundSkinIds = new Set();
    for (const skinPath of skinFiles) {
        const relativePath = relative(skinDirectory, skinPath).split(sep).join('/');
        const expectedHash = createHash('sha256').update(await readFile(skinPath)).digest('hex');
        const skinId = relativePath.split('/')[0];
        if (requiredSkins.get(skinId) !== `background.${expectedHash.slice(0, 16)}.webp`
            || relativePath !== `${skinId}/${requiredSkins.get(skinId)}`) {
            throw new Error(`desktop skin background is not content-addressed: ${relativePath}`);
        }
        foundSkinIds.add(skinId);
        const pathname = `/desktop-skins/${relativePath}`;
        const response = await fetchRequired('desktop skin background', `${normalizedOrigin}${pathname}`);
        assertMime('desktop skin background', pathname, response);
        assertCachePolicy('desktop skin background', pathname, response);
        const remoteHash = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
        if (remoteHash !== expectedHash) throw new Error(`desktop skin background SHA-256 mismatch: ${pathname}`);
    }
    if (foundSkinIds.size !== requiredSkins.size) throw new Error('desktop skin background missing for a required skin');

    const requiredSoundPaths = ['approval', 'complete', 'error', 'start', 'submit']
        .map((name) => `assets/sounds/codeisland/8bit_${name}.wav`);
    for (const soundPath of requiredSoundPaths) {
        const filePath = join(distDirectory, ...soundPath.split('/'));
        if (!assetFiles.includes(filePath)) throw new Error(`required audio asset missing from Web export: ${soundPath}`);
        const url = `${normalizedOrigin}/${soundPath}`;
        const response = await fetchRequired(`audio asset ${soundPath}`, url);
        assertMime(`audio asset ${soundPath}`, soundPath, response);
        assertCachePolicy(`audio asset ${soundPath}`, `/${soundPath}`, response);
        const [expectedBytes, remoteBytes] = await Promise.all([readFile(filePath), response.arrayBuffer()]);
        if (!expectedBytes.equals(Buffer.from(remoteBytes))) {
            throw new Error(`audio asset ${soundPath} content mismatch`);
        }
    }
}

if (immutableMode) {
    const releasePrefix = `/web/releases/${expectedRevision}`;
    const entryResponse = await fetchRequired('immutable release entry', `${normalizedOrigin}${releasePrefix}/index.html`);
    assertMime('immutable release entry', '/index.html', entryResponse);
    assertCachePolicy('immutable release entry', `${releasePrefix}/index.html`, entryResponse);
    assertHtmlRevision('immutable release entry', await entryResponse.text());

    const markerResponse = await fetchRequired('immutable release marker', `${normalizedOrigin}${releasePrefix}/.paws-release-revision`);
    assertCachePolicy('immutable release marker', `${releasePrefix}/.paws-release-revision`, markerResponse);
    const remoteMarker = (await markerResponse.text()).trim();
    if (remoteMarker !== expectedRevision) throw new Error(`immutable release marker mismatch: expected ${expectedRevision}, got ${remoteMarker}`);
    await verifyProjectCanvas();

    for (const reference of references) {
        const response = await fetchRequired(reference, `${normalizedOrigin}${reference}`);
        assertMime(reference, reference, response);
        assertCachePolicy(reference, reference, response);
    }
    console.log(`OK immutable OSS release ${expectedRevision} is safe to activate`);
} else {
    await waitForHealthyServer();
    if (!secondaryCanvasMode) await waitForLegacyWebRedirect();
    for (const { label, url } of [
        { label: 'Web entry', url: `${normalizedOrigin}/` },
        { label: 'SPA route', url: `${normalizedOrigin}/session/web-deploy-check` },
    ]) {
        const response = await fetchRequired(label, url);
        if (secondaryCanvasMode) assertMime(label, '/index.html', response);
        assertHtmlRevision(label, await response.text());
    }
    await verifyProjectCanvas();
    for (const reference of references) {
        const pathname = new URL(reference, normalizedOrigin).pathname;
        const browserFont = secondaryCanvasMode && /\.(?:ttf|woff2?|otf)$/i.test(pathname);
        const response = await fetchRequired(reference, `${normalizedOrigin}${reference}`,
            browserFont ? { headers: { Origin: browserOrigin } } : undefined);
        assertMime(reference, secondaryCanvasMode ? pathname : reference, response);
        assertCachePolicy(reference, reference, response);
        if (browserFont) assertBrowserFontCors(reference, response);
    }

    if (secondaryCanvasMode) {
        console.log(`OK secondary canvas release ${expectedRevision} verified on ${normalizedOrigin}`);
    } else {
        const publicShareUrl = `${normalizedOrigin}/share/public-deployment-probe`;
        const publicShareResponse = await fetchRequired('public share SPA route', publicShareUrl);
        const publicShareContentType = publicShareResponse.headers.get('content-type') ?? '';
        if (!publicShareContentType.includes('text/html')) {
            throw new Error(`public share SPA route did not return HTML: ${publicShareContentType || '(missing)'}`);
        }
        const expectedPublicHeaders = {
            'cache-control': 'no-store',
            'x-robots-tag': 'noindex',
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
            'content-security-policy': "default-src 'self'",
        };
        for (const [header, expected] of Object.entries(expectedPublicHeaders)) {
            const actual = publicShareResponse.headers.get(header) ?? '';
            if (!actual.toLowerCase().includes(expected.toLowerCase())) {
                throw new Error(`public share header ${header} missing ${JSON.stringify(expected)}: ${JSON.stringify(actual)}`);
            }
        }
        assertHtmlRevision('public share SPA route', await publicShareResponse.text());
        console.log('OK public share SPA route security headers');
    }
}
