import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

const [origin, indexPath] = process.argv.slice(2);

if (!origin || !indexPath) {
    throw new Error('Usage: node scripts/verify-web-release.mjs <origin> <index.html>');
}

const normalizedOrigin = origin.replace(/\/+$/, '');
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

for (const requiredPath of ['/metadata.json', '/canvaskit.wasm']) {
    references.add(requiredPath);
}

async function fetchRequired(label, url, init) {
    const response = await fetch(url, { redirect: 'follow', ...init });
    if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}: ${url}`);
    console.log(`OK ${response.status} ${label}`);
    return response;
}

function assertHtmlRevision(label, body) {
    const revisionPattern = /<meta\s+name=["']paws-release-revision["']\s+content=["']([0-9a-f]{40})["']\s*\/?\s*>/i;
    const actualRevision = body.match(revisionPattern)?.[1] ?? null;
    if (actualRevision !== expectedRevision) {
        throw new Error(`${label} release revision mismatch: expected ${expectedRevision}, got ${actualRevision ?? '(missing)'}`);
    }
    console.log(`OK ${expectedRevision} ${label} release revision`);
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

const fontFiles = await listFiles(join(distDirectory, 'assets'));
for (const family of ['Ionicons', 'Octicons']) {
    const fontPath = fontFiles.find((filePath) => filePath.endsWith('.ttf') && filePath.includes(family));
    if (!fontPath) throw new Error(`required ${family} font not found in ${join(distDirectory, 'assets')}`);
    const response = await fetchRequired(family, assetUrlForFile(fontPath), {
        headers: { Origin: normalizedOrigin },
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!/^(font\/|application\/(?:x-font-ttf|font-sfnt))/.test(contentType.toLowerCase())) {
        throw new Error(`${family} returned an invalid font MIME type: ${contentType || '(missing)'}`);
    }
    const allowedOrigin = response.headers.get('access-control-allow-origin') ?? '';
    if (allowedOrigin !== '*' && allowedOrigin !== normalizedOrigin) {
        throw new Error(`${family} Access-Control-Allow-Origin does not cover ${normalizedOrigin}: ${allowedOrigin || '(missing)'}`);
    }
}

await fetchRequired('health endpoint', `${normalizedOrigin}/health`);
for (const { label, url } of [
    { label: 'Web entry', url: `${normalizedOrigin}/` },
    { label: 'SPA route', url: `${normalizedOrigin}/session/web-deploy-check` },
]) {
    const response = await fetchRequired(label, url);
    assertHtmlRevision(label, await response.text());
}
for (const reference of references) {
    await fetchRequired(reference, `${normalizedOrigin}${reference}`);
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
