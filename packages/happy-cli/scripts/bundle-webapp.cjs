#!/usr/bin/env node

/**
 * Runs `expo export -p web` in packages/happy-app and copies the output into
 * happy-cli/tools/webapp/. happy-cli ships this directory so `happy server` can serve the
 * web client statically alongside the API.
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
const OUT_DIR = path.resolve(PACKAGE_DIR, 'tools/webapp');

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

    console.log(`\n→ Copying webapp into ${OUT_DIR}`);
    rmrf(OUT_DIR);
    fs.mkdirSync(path.dirname(OUT_DIR), { recursive: true });
    fs.cpSync(APP_DIST, OUT_DIR, { recursive: true });

    console.log(`\n✓ webapp written to ${OUT_DIR}`);
}

main();
