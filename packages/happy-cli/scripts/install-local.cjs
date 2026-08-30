#!/usr/bin/env node

/**
 * Install this workspace as the global `happy` binary for local development.
 *
 * Steps:
 *   1. build
 *   2. stop any running daemon (ignores failure)
 *   3. npm link (replaces the globally-installed `happy` with a symlink to this workspace)
 *   4. start the daemon again
 *   5. verify by running `happy --version`
 *
 * Reuses ~/.happy/ — no separate dev home dir. Auth and sessions carry over.
 * To undo: `npm unlink -g happy && npm i -g happy@latest`.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const PACKAGE_DIR = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(PACKAGE_DIR, '..', '..');
const IS_WINDOWS = process.platform === 'win32';

function run(cmd, args, { allowFailure = false, env = process.env } = {}) {
    const label = [cmd, ...args].join(' ');
    console.log(`\n▶ ${label}`);
    const result = spawnSync(cmd, args, {
        cwd: PACKAGE_DIR,
        stdio: 'inherit',
        env,
        // shell: true resolves `.cmd` shims on Windows so `pnpm` / `npm` / `happy` are found.
        shell: IS_WINDOWS,
    });
    if (result.error) {
        console.error(`Failed to spawn: ${label}`, result.error.message);
        if (!allowFailure) process.exit(1);
        return 1;
    }
    const status = result.status ?? 1;
    if (status !== 0 && !allowFailure) {
        console.error(`\nExit ${status}: ${label}`);
        process.exit(status);
    }
    return status;
}

function withoutWorkspaceBinPaths() {
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    const inheritedPath = process.env[pathKey] ?? '';
    const cleanPath = inheritedPath
        .split(path.delimiter)
        .filter((entry) => !(
            entry.startsWith(`${WORKSPACE_ROOT}${path.sep}`)
            && entry.endsWith(`${path.sep}node_modules${path.sep}.bin`)
        ))
        .join(path.delimiter);
    return { ...process.env, [pathKey]: cleanPath };
}

run('pnpm', ['run', 'build']);
run('happy', ['daemon', 'stop'], { allowFailure: true });
run('npm', ['link']);
// pnpm prepends workspace node_modules/.bin to PATH for lifecycle scripts.
// A missing optional native agent package can leave a discoverable but broken
// local shim there, shadowing the user's working global Codex/Claude binary in
// every daemon-spawned session. The daemon should inherit the normal shell PATH.
const daemonEnvironment = withoutWorkspaceBinPaths();
run('happy', ['daemon', 'start'], { env: daemonEnvironment });
run('happy', ['--version'], { env: daemonEnvironment });

console.log(`\n✓ Installed from ${PACKAGE_DIR}`);
console.log('  To undo: npm unlink -g happy && npm i -g happy@latest');
