import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const indexPath = process.argv[2];
if (!indexPath) throw new Error('Usage: node scripts/inject-staging-dreamskin-preload.mjs <dist/index.html>');

const skinDirectory = join(dirname(indexPath), 'desktop-skins', 'dreamskin');
const files = await readdir(skinDirectory);
if (files.length !== 1 || !/^background\.[0-9a-f]{16}\.webp$/.test(files[0])) {
    throw new Error('Expected exactly one content-addressed DreamSkin WebP');
}
const name = files[0];
const hash = createHash('sha256').update(await readFile(join(skinDirectory, name))).digest('hex');
if (name !== `background.${hash.slice(0, 16)}.webp`) {
    throw new Error('DreamSkin preload filename does not match its content');
}

const url = `/desktop-skins/dreamskin/${name}`;
const html = await readFile(indexPath, 'utf8');
if (html.includes(`href="${url}"`)) throw new Error('DreamSkin preload already present');
if (!html.includes('</head>')) throw new Error('Web entry has no closing head tag');
const link = `<link rel="preload" as="image" href="${url}" fetchpriority="high">`;
await writeFile(indexPath, html.replace('</head>', `  ${link}\n</head>`));
console.log(`Preloaded ${url}`);
