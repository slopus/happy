import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw Error('Usage: node scripts/write-staging-web-checksums.mjs <dist>');

async function files(path) {
    const result = [];
    for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) result.push(...await files(child));
        else if (entry.isFile() && entry.name !== '.paws-staging-checksums.sha256') result.push(child);
        else if (!entry.isFile()) throw Error(`Unsupported release entry: ${child}`);
    }
    return result;
}

const entries = await files(root);
const lines = [];
for (const file of entries.sort()) {
    const name = `./${relative(root, file).split(sep).join('/')}`;
    if (/[\r\n\\]/.test(name)) throw Error(`Unsafe release filename: ${name}`);
    const hash = createHash('sha256').update(await readFile(file)).digest('hex');
    lines.push(`${hash}  ${name}`);
}
await writeFile(join(root, '.paws-staging-checksums.sha256'), `${lines.join('\n')}\n`);
process.stdout.write(`${lines.length} release files checksummed\n`);
