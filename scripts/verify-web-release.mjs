import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

const [origin, indexPath, mode, browserOriginArgument] = process.argv.slice(2);

if (!origin || !indexPath) {
    throw new Error('Usage: node scripts/verify-web-release.mjs <origin> <index.html> [--immutable <browser-origin>]');
}
if (mode && mode !== '--immutable') throw new Error(`unknown verification mode: ${mode}`);
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
const references = new Set();
const attributePattern = /(?:src|href)=["']([^"']+)["']/gi;

for (const match of html.matchAll(attributePattern)) {
    const reference = match[1];
    if (reference.startsWith('/') && !reference.startsWith('//')) {
        references.add(reference);
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

async function fetchRequired(label, url, init) {
    const response = await fetch(url, { redirect: 'follow', ...init });
    if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}: ${url}`);
    console.log(`OK ${response.status} ${label}`);
    return response;
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
            lastError = error;
            if (Date.now() >= deadline) break;
            await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(healthRetryIntervalMs, deadline - Date.now())));
        }
    } while (Date.now() <= deadline);
    throw new Error(`health endpoint did not become ready within ${healthTimeoutMs}ms: ${lastError?.message ?? 'unknown error'}`, {
        cause: lastError,
    });
}

function assertHtmlRevision(label, body) {
    const revisionPattern = /<meta\s+name=["']paws-release-revision["']\s+content=["']([0-9a-f]{40})["']\s*\/?\s*>/i;
    const actualRevision = body.match(revisionPattern)?.[1] ?? null;
    if (actualRevision !== expectedRevision) {
        throw new Error(`${label} release revision mismatch: expected ${expectedRevision}, got ${actualRevision ?? '(missing)'}`);
    }
    console.log(`OK ${expectedRevision} ${label} release revision`);
}

function expectedMimePattern(pathname) {
    if (pathname.endsWith('/apple-app-site-association') || pathname.endsWith('.json')) return /^application\/(?:[a-z0-9.+-]+\+)?json\b/i;
    if (pathname.endsWith('.js')) return /^(?:application|text)\/javascript\b/i;
    if (pathname.endsWith('.css')) return /^text\/css\b/i;
    if (pathname.endsWith('.wasm')) return /^application\/wasm\b/i;
    if (pathname.endsWith('.ttf')) return /^(?:font\/ttf|application\/(?:x-font-ttf|font-sfnt))\b/i;
    if (pathname.endsWith('.woff2')) return /^font\/woff2\b/i;
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
    const immutable = pathname.startsWith('/web/releases/') || pathname.startsWith('/_expo/') || pathname.startsWith('/assets/');
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

const assetFiles = await listFiles(join(distDirectory, 'assets'));
for (const family of ['Ionicons', 'Octicons']) {
    const fontPath = assetFiles.find((filePath) => filePath.endsWith('.ttf') && filePath.includes(family));
    if (!fontPath) throw new Error(`required ${family} font not found in ${join(distDirectory, 'assets')}`);
    const response = await fetchRequired(family, assetUrlForFile(fontPath), {
        headers: { Origin: browserOrigin },
    });
    assertMime(family, fontPath, response);
    assertCachePolicy(family, assetUrlForFile(fontPath).slice(normalizedOrigin.length), response);
    const allowedOrigin = response.headers.get('access-control-allow-origin') ?? '';
    if (allowedOrigin !== '*' && allowedOrigin !== browserOrigin) {
        throw new Error(`${family} Access-Control-Allow-Origin does not cover ${browserOrigin}: ${allowedOrigin || '(missing)'}`);
    }
}

const representativeImagePath = assetFiles.find((filePath) => /\.(?:png|jpe?g|gif|webp|svg)$/i.test(filePath));
if (!representativeImagePath) throw new Error(`representative image asset not found in ${join(distDirectory, 'assets')}`);
const representativeImageUrl = assetUrlForFile(representativeImagePath);
const representativeImageResponse = await fetchRequired('representative image asset', representativeImageUrl);
assertMime('representative image asset', representativeImagePath, representativeImageResponse);
assertCachePolicy('representative image asset', representativeImageUrl.slice(normalizedOrigin.length), representativeImageResponse);

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

    for (const reference of references) {
        const response = await fetchRequired(reference, `${normalizedOrigin}${reference}`);
        assertMime(reference, reference, response);
        assertCachePolicy(reference, reference, response);
    }
    console.log(`OK immutable OSS release ${expectedRevision} is safe to activate`);
} else {
    await waitForHealthyServer();
    for (const { label, url } of [
        { label: 'Web entry', url: `${normalizedOrigin}/` },
        { label: 'SPA route', url: `${normalizedOrigin}/session/web-deploy-check` },
    ]) {
        const response = await fetchRequired(label, url);
        assertHtmlRevision(label, await response.text());
    }
    for (const reference of references) {
        const response = await fetchRequired(reference, `${normalizedOrigin}${reference}`);
        assertMime(reference, reference, response);
        assertCachePolicy(reference, reference, response);
    }

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
