#!/usr/bin/env node

/**
 * Install this workspace as the global `happy` binary for local development.
 *
 * Steps:
 *   1. build happy-wire and happy-cli
 *   2. prepare and guard the publish artifact
 *   3. stop any running daemon (ignores failure)
 *   4. npm install -g the guarded tarball
 *   5. verify bundled runtime deps
 *   6. start the daemon again
 *   7. verify by running `happy --version`
 *
 * Reuses ~/.happy/ - no separate dev home dir. Auth and sessions carry over.
 * To undo: `npm uninstall -g @namsangboy/happy-cli && npm i -g @namsangboy/happy-cli@latest`.
 */

const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const path = require('path');

const PACKAGE_DIR = path.resolve(__dirname, '..');
const IS_WINDOWS = process.platform === 'win32';

function run(cmd, args, { allowFailure = false } = {}) {
    const label = [cmd, ...args].join(' ');
    console.log(`\n▶ ${label}`);
    const result = spawnSync(cmd, args, {
        cwd: PACKAGE_DIR,
        stdio: 'inherit',
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

function runOutput(cmd, args) {
    const label = [cmd, ...args].join(' ');
    console.log(`\n▶ ${label}`);
    const result = spawnSync(cmd, args, {
        cwd: PACKAGE_DIR,
        encoding: 'utf8',
        shell: IS_WINDOWS,
    });

    if (result.error) {
        console.error(`Failed to spawn: ${label}`, result.error.message);
        process.exit(1);
    }

    const status = result.status ?? 1;
    if (status !== 0) {
        console.error(`\nExit ${status}: ${label}`);
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exit(status);
    }

    return result.stdout;
}

function packPreparedPackage(preparedDir, outputDir) {
    const result = spawnSync('npm', [
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        outputDir
    ], {
        cwd: preparedDir,
        encoding: 'utf8',
        shell: IS_WINDOWS,
    });

    if (result.error) {
        console.error('Failed to spawn: npm pack', result.error.message);
        process.exit(1);
    }

    const status = result.status ?? 1;
    if (status !== 0) {
        console.error('\nExit ' + status + ': npm pack');
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exit(status);
    }

    const stdout = result.stdout;
    const jsonStart = stdout.indexOf('[');
    const jsonEnd = stdout.lastIndexOf(']');

    if (jsonStart === -1 || jsonEnd === -1) {
        console.error(`Unable to parse npm pack output:\n${stdout}`);
        process.exit(1);
    }

    const packed = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
    const filename = packed[0] && packed[0].filename;

    if (!filename) {
        console.error(`npm pack did not return a tarball filename:\n${stdout}`);
        process.exit(1);
    }

    return path.join(outputDir, filename);
}

function verifyBundledDependency() {
    const npmRoot = runOutput('npm', ['root', '-g']).trim();
    const wireEntry = path.join(
        npmRoot,
        '@namsangboy',
        'happy-cli',
        'node_modules',
        '@slopus',
        'happy-wire',
        'dist',
        'index.mjs'
    );

    if (!fs.existsSync(wireEntry)) {
        console.error(`Installed happy-cli is missing bundled @slopus/happy-wire: ${wireEntry}`);
        process.exit(1);
    }

    console.log(`\n✓ Bundled @slopus/happy-wire found at ${wireEntry}`);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-cli-local-install-'));
const preparedDir = path.join(tempDir, 'package');

try {
    run('pnpm', ['--filter', '@slopus/happy-wire', 'run', 'build']);
    run('pnpm', ['run', 'build']);
    run('node', ['scripts/prepare-publish-package.cjs', '--out', preparedDir]);
    run('node', ['scripts/guard-publish-artifact.cjs', preparedDir, '--install-smoke']);

    const tarball = packPreparedPackage(preparedDir, tempDir);

    run('happy', ['daemon', 'stop'], { allowFailure: true });
    run('npm', ['install', '-g', tarball]);
    verifyBundledDependency();
    run('happy', ['daemon', 'start']);
    run('happy', ['--version']);
} finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
}

console.log(`\n✓ Installed from ${PACKAGE_DIR}`);
console.log('  To undo: npm uninstall -g @namsangboy/happy-cli && npm i -g @namsangboy/happy-cli@latest');
