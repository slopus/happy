import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

export function assertMatchingIntegrity(localIntegrity, registryIntegrity) {
    if (!localIntegrity || !registryIntegrity || localIntegrity !== registryIntegrity) {
        throw new Error(`Registry tarball integrity mismatch: local=${localIntegrity || '(missing)'} registry=${registryIntegrity || '(missing)'}`);
    }
    return localIntegrity;
}

export async function fileIntegrity(path) {
    const bytes = await readFile(path);
    return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

async function main() {
    const [tarball, packageSpec] = process.argv.slice(2);
    if (!tarball || !packageSpec) throw new Error('Usage: node verify-registry-integrity.mjs <tarball> <package@version>');
    const [{ stdout }, localIntegrity] = await Promise.all([
        execFileAsync('npm', ['view', packageSpec, 'dist.integrity', '--json'], { encoding: 'utf8' }),
        fileIntegrity(tarball),
    ]);
    const registryIntegrity = JSON.parse(stdout);
    assertMatchingIntegrity(localIntegrity, registryIntegrity);
    process.stdout.write(`${localIntegrity}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    await main();
}
