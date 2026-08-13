import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [origin, indexPath] = process.argv.slice(2);

if (!origin || !indexPath) {
    throw new Error('Usage: node scripts/verify-web-release.mjs <origin> <index.html>');
}

const normalizedOrigin = origin.replace(/\/+$/, '');
const html = await readFile(resolve(indexPath), 'utf8');
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

const requiredResponses = [
    { label: 'health endpoint', url: `${normalizedOrigin}/health` },
    { label: 'Web entry', url: `${normalizedOrigin}/` },
    { label: 'SPA route', url: `${normalizedOrigin}/session/web-deploy-check` },
    ...[...references].map((reference) => ({ label: reference, url: `${normalizedOrigin}${reference}` })),
];

for (const { label, url } of requiredResponses) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
        throw new Error(`${label} failed with HTTP ${response.status}: ${url}`);
    }
    console.log(`OK ${response.status} ${label}`);
}
