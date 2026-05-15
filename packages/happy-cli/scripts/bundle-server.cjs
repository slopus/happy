#!/usr/bin/env node

/**
 * Bundles happy-server into a self-contained artifact shipped inside happy-cli/tools/server/.
 *
 * Uses `bun build --compile` to produce a single platform-specific binary, then copies the
 * pglite WASM/data files and prisma migrations alongside. happy-cli does NOT depend on the
 * happy-server workspace package — we reach into the sibling directory at build time only.
 *
 * Layout produced:
 *   tools/server/
 *     <platform>/
 *       happy-server                  # bun-compiled binary
 *       pglite.wasm                   # PGlite expects these next to process.execPath
 *       pglite.data
 *       prisma/migrations/...
 *
 * Default: builds for the current host platform only. Pass --all-platforms to cross-build
 * for all six (used by release/CI).
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const PACKAGE_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_DIR, '..', '..');
const SERVER_DIR = path.resolve(REPO_ROOT, 'packages/happy-server');
const OUT_DIR = path.resolve(PACKAGE_DIR, 'tools/server');

const BUN_TARGETS = {
    'arm64-darwin': 'bun-darwin-arm64',
    'x64-darwin': 'bun-darwin-x64',
    'arm64-linux': 'bun-linux-arm64',
    'x64-linux': 'bun-linux-x64',
    'x64-win32': 'bun-windows-x64',
};

function currentPlatform() {
    const platform = os.platform();
    const arch = os.arch();
    return `${arch}-${platform}`;
}

function platformBinaryName(plat) {
    return plat.endsWith('-win32') ? 'happy-server.exe' : 'happy-server';
}

function run(cmd, args, opts = {}) {
    console.log(`  $ ${cmd} ${args.join(' ')}`);
    const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

function rmrf(p) {
    fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dst) {
    fs.cpSync(src, dst, { recursive: true });
}

function findPgliteAsset(name) {
    const candidates = [
        path.join(REPO_ROOT, 'node_modules/@electric-sql/pglite/dist', name),
        path.join(SERVER_DIR, 'node_modules/@electric-sql/pglite/dist', name),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return null;
}

function buildPlatform(plat) {
    if (!BUN_TARGETS[plat]) {
        console.error(`Unsupported platform: ${plat}`);
        process.exit(1);
    }
    const target = BUN_TARGETS[plat];
    const outDir = path.join(OUT_DIR, plat);
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, platformBinaryName(plat));

    console.log(`\n→ Bundling happy-server for ${plat} (${target})`);
    run(
        'bun',
        [
            'build',
            './sources/standalone.ts',
            '--compile',
            '--outfile',
            outFile,
            '--target',
            target,
            // optional peer deps we don't bundle (only relevant when running against external redis)
            '--external',
            'redis',
            '--external',
            '@prisma/engines',
            '--external',
            'prisma',
        ],
        { cwd: SERVER_DIR }
    );
}

function copyAssetsForPlatform(plat) {
    const platDir = path.join(OUT_DIR, plat);
    console.log(`\n→ Copying assets (pglite + migrations) into ${path.relative(PACKAGE_DIR, platDir)}`);

    for (const asset of ['pglite.wasm', 'pglite.data']) {
        const src = findPgliteAsset(asset);
        if (!src) {
            console.error(`Could not find ${asset} in @electric-sql/pglite/dist`);
            process.exit(1);
        }
        fs.copyFileSync(src, path.join(platDir, asset));
        console.log(`  copied ${asset}`);
    }

    const migrationsSrc = path.join(SERVER_DIR, 'prisma/migrations');
    const migrationsDst = path.join(platDir, 'prisma/migrations');
    fs.mkdirSync(path.dirname(migrationsDst), { recursive: true });
    copyDir(migrationsSrc, migrationsDst);
    console.log(`  copied prisma/migrations`);
}

function main() {
    const args = process.argv.slice(2);
    const allPlatforms = args.includes('--all-platforms');

    if (!fs.existsSync(SERVER_DIR)) {
        console.error(`Missing ${SERVER_DIR}. Run from the monorepo.`);
        process.exit(1);
    }

    rmrf(OUT_DIR);
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const targets = allPlatforms ? Object.keys(BUN_TARGETS) : [currentPlatform()];
    for (const plat of targets) {
        buildPlatform(plat);
        copyAssetsForPlatform(plat);
    }

    console.log(`\n✓ happy-server bundle written to ${OUT_DIR}`);
}

main();
