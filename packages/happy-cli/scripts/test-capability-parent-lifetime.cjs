#!/usr/bin/env node

/**
 * Finite Darwin-only lifecycle check. It starts the helper under a throwaway
 * Node owner, kills that owner, and verifies that the helper exits after its
 * parent-PID check. It never targets the current CLI or daemon process.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const helperPath = process.argv[2] || path.resolve(__dirname, '..', 'tools', 'unpacked', 'happy-capability');
const timeoutMs = 3000;

if (process.platform !== 'darwin') {
    console.log('Skipping macOS capability parent-lifetime check on non-Darwin.');
    process.exit(0);
}

const ownerSource = [
    "const { spawn } = require('node:child_process');",
    "const helper = spawn(process.argv[1], [], { stdio: ['ignore', 'ignore', 'ignore'] });",
    "process.stdout.write(String(helper.pid) + '\\n');",
    "setInterval(() => {}, 1000);",
].join('\n');

const owner = spawn(process.execPath, ['-e', ownerSource, helperPath], {
    stdio: ['ignore', 'pipe', 'inherit'],
});

function waitForLine(stream) {
    return new Promise((resolve, reject) => {
        let buffer = '';
        const onData = (chunk) => {
            buffer += chunk.toString();
            const newline = buffer.indexOf('\n');
            if (newline >= 0) {
                cleanup();
                resolve(buffer.slice(0, newline).trim());
            }
        };
        const onEnd = () => {
            cleanup();
            reject(new Error('throwaway owner exited before reporting helper PID'));
        };
        const cleanup = () => {
            stream.off('data', onData);
            stream.off('end', onEnd);
        };
        stream.on('data', onData);
        stream.on('end', onEnd);
    });
}

function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error && error.code === 'ESRCH') return false;
        throw error;
    }
}

async function main() {
    const helperPid = Number.parseInt(await waitForLine(owner.stdout), 10);
    if (!Number.isInteger(helperPid) || helperPid <= 1) {
        throw new Error(`invalid helper PID: ${helperPid}`);
    }

    // This is the isolated fixture owner, never the current process.
    owner.kill('SIGKILL');
    await new Promise((resolve) => owner.once('close', resolve));

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && isAlive(helperPid)) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (isAlive(helperPid)) {
        // The PID came from the throwaway owner immediately above. Clean up
        // only that helper before failing, never a daemon or current CLI.
        process.kill(helperPid, 'SIGTERM');
        throw new Error(`helper ${helperPid} survived parent death for ${timeoutMs}ms`);
    }

    console.log('Capability helper exited after throwaway parent death.');
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});