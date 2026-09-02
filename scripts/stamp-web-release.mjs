import { readFile, writeFile } from 'node:fs/promises';

const [indexPath, markerPath, revision] = process.argv.slice(2);

if (!indexPath || !markerPath || !revision) {
    throw new Error('Usage: node scripts/stamp-web-release.mjs <index.html> <marker> <revision>');
}
if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error('Web release revision must be a 40-character lowercase Git SHA.');
}

const source = await readFile(indexPath, 'utf8');
const meta = `<meta name="paws-release-revision" content="${revision}">`;
const existingMeta = /<meta\s+name=["']paws-release-revision["'][^>]*>/gi;
let stamped = source.replace(existingMeta, '');
const headEnd = stamped.search(/<\/head\s*>/i);
if (headEnd < 0) throw new Error(`Web entry has no </head>: ${indexPath}`);
stamped = `${stamped.slice(0, headEnd)}  ${meta}\n${stamped.slice(headEnd)}`;

await writeFile(markerPath, `${revision}\n`, 'utf8');
await writeFile(indexPath, stamped, 'utf8');
process.stdout.write(`${revision}\n`);
