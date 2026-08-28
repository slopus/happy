import { readFile } from 'node:fs/promises';
import { appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function validateReleaseContract({ tag, version, tagSha, headSha }) {
    const expectedTag = `paws-agent-v${version}`;
    if (tag !== expectedTag) throw new Error(`Expected tag ${expectedTag}, received ${tag}`);
    if (!tagSha || tagSha !== headSha) throw new Error('Release tag must point at the checked-out commit');
    return { version, distTag: version.includes('-') ? 'next' : 'latest' };
}

async function main() {
    const manifest = JSON.parse(await readFile(resolve(packageDir, 'package.json'), 'utf8'));
    const result = validateReleaseContract({
        tag: process.env.PAWS_RELEASE_TAG ?? process.env.GITHUB_REF_NAME,
        version: manifest.version,
        tagSha: process.env.PAWS_TAG_SHA,
        headSha: process.env.GITHUB_SHA,
    });
    if (process.env.GITHUB_OUTPUT) {
        await appendFile(process.env.GITHUB_OUTPUT, `version=${result.version}\ndist_tag=${result.distTag}\n`);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    await main();
}
