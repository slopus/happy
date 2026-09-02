import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const verifierPath = fileURLToPath(new URL('./verify-web-rollback.mjs', import.meta.url));

async function runVerifier({ hangingPath } = {}) {
    const server = http.createServer((request, response) => {
        if (request.url === hangingPath) return;
        response.statusCode = 200;
        response.end('ok');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;

    try {
        return await new Promise((resolve) => {
            const child = spawn(process.execPath, [verifierPath, origin], {
                env: {
                    ...process.env,
                    PAWS_WEB_ROLLBACK_RETRY_INTERVAL_MS: '10',
                    PAWS_WEB_ROLLBACK_TIMEOUT_MS: '500',
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            const killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
            child.stdout.on('data', (chunk) => { stdout += chunk; });
            child.stderr.on('data', (chunk) => { stderr += chunk; });
            child.on('close', (status) => {
                clearTimeout(killTimer);
                resolve({ status, stdout, stderr });
            });
        });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test('accepts a responsive rollback entry and health route', async () => {
    const result = await runVerifier();

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /rollback data plane is reachable/i);
});

test('enforces one hard deadline when a rollback endpoint never responds', async () => {
    const startedAt = Date.now();
    const result = await runVerifier({ hangingPath: '/health' });

    assert.notEqual(result.status, 0);
    assert.ok(Date.now() - startedAt < 1_500, 'rollback verifier exceeded its hard deadline');
    assert.match(result.stderr, /rollback data plane.*within 500ms/i);
});
