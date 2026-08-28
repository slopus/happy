import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageDir, '..', '..');
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function validateReleasePreparation({ branch, version }) {
    if (!semverPattern.test(version)) {
        throw new Error(`Invalid semantic version: ${version}`);
    }
    const expectedBranch = `release/paws-agent-v${version}`;
    if (branch !== expectedBranch) {
        throw new Error(`Release preparation must run on ${expectedBranch}, received ${branch}`);
    }
    return { branch, version };
}

function git(args) {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function releaseNotes(version) {
    const tags = git(['tag', '--list', 'paws-agent-v*', '--sort=-v:refname'])
        .split('\n')
        .map(value => value.trim())
        .filter(Boolean);
    const previous = tags[0];
    const range = previous ? `${previous}..HEAD` : 'HEAD';
    const log = git(['log', range, '--pretty=format:- %s (%h)', '--', 'packages/paws-agent', '.github/workflows/paws-agent-*.yml']);
    const entries = log || '- Initial Paws Agent release preparation.';
    return `## ${version} - ${new Date().toISOString().slice(0, 10)}\n\n${entries}\n\n`;
}

async function main() {
    const version = process.argv[2];
    if (!version) throw new Error('Usage: pnpm release:prepare -- <version>');
    const branch = git(['branch', '--show-current']);
    validateReleasePreparation({ branch, version });
    if (git(['status', '--porcelain'])) throw new Error('Release preparation requires a clean working tree');
    if (git(['tag', '--list', `paws-agent-v${version}`])) throw new Error(`Release tag paws-agent-v${version} already exists`);

    const manifestPath = resolve(packageDir, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.version === version) throw new Error(`Package is already at ${version}`);
    manifest.version = version;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const changelogPath = resolve(packageDir, 'CHANGELOG.md');
    let existing = '';
    try {
        existing = await readFile(changelogPath, 'utf8');
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    const header = existing.startsWith('# Changelog') ? existing : `# Changelog\n\n${existing}`;
    await writeFile(changelogPath, `# Changelog\n\n${releaseNotes(version)}${header.replace(/^# Changelog\s*/, '')}`);
    process.stdout.write(`Prepared ${manifest.name}@${version} on ${branch}. Commit these files in the release PR.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    await main();
}
