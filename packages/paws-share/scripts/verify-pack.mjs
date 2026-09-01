import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageDirectory, '../..');
const workspace = await mkdtemp(join(tmpdir(), 'paws-share-pack-'));
const outputDirectory = resolve(process.env.PAWS_SHARE_PACK_DIR ?? join(repositoryRoot, 'artifacts/paws-share-pack'));
const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));

async function run(command, args, options = {}) {
    try {
        return await exec(command, args, {
            cwd: options.cwd ?? packageDirectory,
            env: { ...process.env, ...options.env },
            maxBuffer: 20 * 1024 * 1024,
        });
    } catch (error) {
        const details = [error.stdout, error.stderr].filter(Boolean).join('\n');
        throw new Error(`${command} ${args.join(' ')} failed${details ? `:\n${details}` : ''}`, { cause: error });
    }
}

await mkdir(outputDirectory, { recursive: true });
for (const entry of await readdir(outputDirectory)) {
    if (entry.startsWith('wangjs-jacky-paws-share-') && entry.endsWith('.tgz')) {
        await rm(join(outputDirectory, entry));
    }
}
await run('pnpm', ['run', 'build']);
const packed = await run('pnpm', ['pack', '--pack-destination', outputDirectory]);
const tarballLine = packed.stdout.trim().split(/\r?\n/).findLast((line) => line.trim().endsWith('.tgz'));
if (!tarballLine) throw new Error(`Unable to find packed tarball in output:\n${packed.stdout}`);
const tarball = resolve(packageDirectory, tarballLine.trim());
await access(tarball, constants.R_OK);

const archive = await run('tar', ['-tzf', tarball], { cwd: workspace });
const listing = archive.stdout.trim().split(/\r?\n/).filter(Boolean);
for (const required of [
    'package/package.json',
    'package/README.md',
    'package/bin/paws-share.mjs',
    'package/dist/cli.mjs',
    'package/dist/index.mjs',
    'package/dist/index.cjs',
    'package/skills/share-session/SKILL.md',
    'package/skills/share-session/agents/openai.yaml',
]) {
    if (!listing.includes(required)) throw new Error(`Packed artifact is missing ${required}`);
}
if (listing.some((entry) => entry.includes('/src/') || entry.includes('.test.'))) {
    throw new Error('Packed artifact contains source or test files');
}

await run('npm', ['init', '-y'], { cwd: workspace });
await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: workspace });
const cli = join(workspace, 'node_modules/.bin/paws-share');
const version = await run(cli, ['--version'], { cwd: workspace });
if (version.stdout.trim() !== manifest.version) throw new Error(`Unexpected packed CLI version: ${version.stdout.trim()}`);
const help = await run(cli, ['--help'], { cwd: workspace });
if (!help.stdout.includes('inspect') || !help.stdout.includes('install-skill')) throw new Error('Packed CLI help is incomplete');

const inspection = await run(cli, [
    'inspect', '--source', 'codex', '--session', join(packageDirectory, 'test/fixtures/codex-session.jsonl'), '--json',
], { cwd: workspace });
const inspectionJson = JSON.parse(inspection.stdout);
if (inspectionJson.source !== 'codex' || inspectionJson.attachmentCount !== 1) throw new Error('Packed CLI fixture inspection failed');

const codexHome = join(workspace, 'codex-home');
const claudeHome = join(workspace, 'claude-home');
await run(cli, ['install-skill', '--target', 'all', '--json'], {
    cwd: workspace,
    env: { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome },
});
await access(join(codexHome, 'skills/share-session/SKILL.md'), constants.R_OK);
await access(join(claudeHome, 'skills/share-session/SKILL.md'), constants.R_OK);

const esm = await run(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(manifest.name)})`], { cwd: workspace });
const cjs = await run(process.execPath, ['-e', `require(${JSON.stringify(manifest.name)})`], { cwd: workspace });
if (esm.stdout || esm.stderr || cjs.stdout || cjs.stderr) throw new Error('Package import produced output');

const tarballBytes = await readFile(tarball);
const checksum = createHash('sha256').update(tarballBytes).digest('hex');
const checksumPath = join(outputDirectory, 'SHA256SUMS');
await writeFile(checksumPath, `${checksum}  ${basename(tarball)}\n`);

process.stdout.write(`${JSON.stringify({
    package: manifest.name,
    version: manifest.version,
    tarball,
    sha256: checksum,
    files: listing.length,
    checks: ['contents', 'clean-install', 'esm', 'cjs', 'cli', 'fixture', 'skill-install'],
}, null, 2)}\n`);
