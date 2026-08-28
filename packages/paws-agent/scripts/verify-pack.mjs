import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageDir, '../..');
const workspace = await mkdtemp(join(tmpdir(), 'paws-agent-pack-'));
const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
const providedTarball = process.argv[2] ? resolve(process.argv[2]) : null;

async function run(command, args, options = {}) {
    try {
        return await exec(command, args, {
            cwd: options.cwd ?? packageDir,
            env: { ...process.env, ...options.env },
            maxBuffer: 10 * 1024 * 1024,
        });
    } catch (error) {
        const details = [error.stdout, error.stderr].filter(Boolean).join('\n');
        throw new Error(`${command} ${args.join(' ')} failed${details ? `:\n${details}` : ''}`, { cause: error });
    }
}

let tarball;
let listing;
if (providedTarball) {
    await access(providedTarball, constants.R_OK);
    tarball = providedTarball;
    const archive = await run('tar', ['-tzf', tarball], { cwd: workspace });
    listing = archive.stdout.trim().split(/\r?\n/).filter(Boolean);
} else {
    await run('pnpm', ['run', 'build']);
    const packed = await run('npm', [
        'pack', '--json', '--ignore-scripts', '--pack-destination', workspace,
    ]);
    const packResult = JSON.parse(packed.stdout)[0];
    tarball = join(workspace, packResult.filename);
    listing = packResult.files.map(file => `package/${file.path}`);
}

for (const required of [
    'package/package.json',
    'package/bin/paws-agent.mjs',
    'package/dist/index.mjs',
    'package/dist/index.cjs',
    'package/dist/index.d.mts',
    'package/dist/index.d.cts',
    'package/dist/browser.mjs',
    'package/dist/node.mjs',
]) {
    if (!listing.includes(required)) throw new Error(`Packed artifact is missing ${required}`);
}
if (listing.some(entry => entry.includes('/src/') || entry.includes('.test.'))) {
    throw new Error('Packed artifact contains source or test files');
}

const unpacked = join(workspace, 'unpacked');
await mkdir(unpacked);
await run('tar', ['-xzf', tarball, '-C', unpacked], { cwd: workspace });
const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\/\/registry\.npmjs\.org\/:_authToken\s*=/,
    /\bnpm_[A-Za-z0-9]{20,}\b/,
];
async function scanSecrets(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            await scanSecrets(path);
            continue;
        }
        const content = await readFile(path).catch(() => null);
        if (!content || content.includes(0)) continue;
        const text = content.toString('utf8');
        if (secretPatterns.some(pattern => pattern.test(text))) {
            throw new Error(`Packed artifact contains a credential-like value in ${path.slice(unpacked.length + 1)}`);
        }
    }
}
await scanSecrets(unpacked);

await run('npm', ['publish', '--dry-run', '--json', '--ignore-scripts', '--tag', process.env.PAWS_AGENT_DIST_TAG ?? 'next', tarball], { cwd: workspace });
await run('npm', ['init', '-y'], { cwd: workspace });
await run('npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org',
    process.env.PAWS_AGENT_INSTALL_SPEC ?? tarball,
], { cwd: workspace });
await run('npm', [
    'exec', '--yes', '--package=publint@0.3.24', '--', 'publint',
    join(workspace, 'node_modules/@wangjs-jacky/paws-agent'),
], { cwd: workspace });

await copyFile(join(packageDir, 'test/consumer/esm/index.mjs'), join(workspace, 'esm.mjs'));
await copyFile(join(packageDir, 'test/consumer/cjs/index.cjs'), join(workspace, 'cjs.cjs'));
for (const entry of ['esm.mjs', 'cjs.cjs']) {
    const result = await run(process.execPath, [join(workspace, entry)], { cwd: workspace });
    if (result.stdout || result.stderr) throw new Error(`${entry} produced import-time output`);
}

const cli = join(workspace, 'node_modules/.bin/paws-agent');
const version = await run(cli, ['--version'], { cwd: workspace });
if (version.stdout.trim() !== manifest.version) throw new Error(`Unexpected CLI version: ${version.stdout.trim()}`);
const help = await run(cli, ['--help'], { cwd: workspace });
if (!help.stdout.includes('paws-agent') || !help.stdout.includes('approve')) {
    throw new Error('Packed CLI help is incomplete');
}

const browserDir = join(workspace, 'browser');
await mkdir(browserDir);
await copyFile(join(packageDir, 'test/browser/main.ts'), join(browserDir, 'main.ts'));
await copyFile(join(packageDir, 'test/browser/index.html'), join(browserDir, 'index.html'));
const esbuild = join(repositoryRoot, 'node_modules/.bin/esbuild');
await run(esbuild, [
    join(browserDir, 'main.ts'), '--bundle', '--platform=browser', '--format=iife',
    `--outfile=${join(browserDir, 'bundle.js')}`,
], { cwd: workspace });
const browserBundle = await readFile(join(browserDir, 'bundle.js'), 'utf8');
for (const forbidden of ['node:', 'Buffer.from', 'process.env', 'paws-agent auth login']) {
    if (browserBundle.includes(forbidden)) throw new Error(`Browser bundle contains forbidden token: ${forbidden}`);
}

const { chromium } = await import('playwright');
const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let executablePath = process.env.PAWS_CHROMIUM_EXECUTABLE;
if (!executablePath) {
    try {
        await access(systemChrome, constants.X_OK);
        executablePath = systemChrome;
    } catch {
        executablePath = undefined;
    }
}
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(join(browserDir, 'index.html')).href);
    await page.waitForFunction(() => window.__PAWS_AGENT_VERIFY__ === 'ready');
} finally {
    await browser.close();
}

const bytes = await readFile(tarball);
const checksum = createHash('sha256').update(bytes).digest('hex');
await writeFile(join(workspace, 'SHA256SUMS'), `${checksum}  ${basename(tarball)}\n`);

process.stdout.write(JSON.stringify({
    package: manifest.name,
    version: manifest.version,
    tarball,
    sha256: checksum,
    files: listing.length,
    installSpec: process.env.PAWS_AGENT_INSTALL_SPEC ?? tarball,
    checks: ['metadata', 'secret-scan', 'dry-run', 'publint', 'esm', 'cjs', 'cli', 'browser-bundle', 'chromium'],
}, null, 2) + '\n');
