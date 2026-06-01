#!/usr/bin/env node

/**
 * Runs `expo export -p web` in packages/happy-app and copies the output into
 * a package-owned artifact directory. By default this writes to happy-cli/tools/webapp
 * for local development. Release packaging can pass --out-dir to place it elsewhere.
 *
 * happy-cli does NOT depend on happy-app — we reach into the sibling at build time only.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PACKAGE_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_DIR, '..', '..');
const APP_DIR = path.resolve(REPO_ROOT, 'packages/happy-app');
const APP_DIST = path.join(APP_DIR, 'dist');

function rmrf(p) {
    fs.rmSync(p, { recursive: true, force: true });
}

function run(cmd, args, opts = {}) {
    console.log(`  $ ${cmd} ${args.join(' ')}`);
    const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

function main() {
    const args = process.argv.slice(2);
    const outDirArg = valueAfter(args, '--out-dir');
    const outDir = outDirArg ? path.resolve(process.cwd(), outDirArg) : path.resolve(PACKAGE_DIR, 'tools/webapp');

    if (!fs.existsSync(APP_DIR)) {
        console.error(`Missing ${APP_DIR}. Run from the monorepo.`);
        process.exit(1);
    }

    console.log(`→ Building happy-app web bundle (expo export)`);
    rmrf(APP_DIST);
    run('pnpm', ['exec', 'expo', 'export', '-p', 'web', '--output-dir', 'dist'], { cwd: APP_DIR });

    if (!fs.existsSync(path.join(APP_DIST, 'index.html'))) {
        console.error(`Expected ${path.join(APP_DIST, 'index.html')} after expo export, but it's missing.`);
        process.exit(1);
    }

    console.log(`\n→ Copying webapp into ${outDir}`);
    rmrf(outDir);
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    fs.cpSync(APP_DIST, outDir, { recursive: true });

    console.log(`\n✓ webapp written to ${outDir}`);
}

function valueAfter(args, flag) {
    const idx = args.indexOf(flag);
    if (idx === -1) return null;
    const value = args[idx + 1];
    if (!value || value.startsWith('--')) {
        console.error(`Missing value for ${flag}`);
        process.exit(1);
    }
    return value;
}

main();
