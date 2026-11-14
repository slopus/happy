import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const run = promisify(execFile);
const script = fileURLToPath(new URL('./stack.mjs', import.meta.url));

test('prepare preserves independent private secrets and emits no values', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rakazo-stack-'));
    try {
        const first = await run(process.execPath, [script, 'prepare', '--directory', directory]);
        const contents = await readFile(path.join(directory, '.env'), 'utf8');
        const secrets = contents.split('\n').filter(line => /^(POSTGRES_PASSWORD|POSTGRES_APP_PASSWORD|BETTER_AUTH_SECRET|ENCRYPTION_KEY|SCREEN_PROXY_SECRET)=/.test(line)).map(line => line.split('=')[1]);
        assert.equal(secrets.length, 5);
        assert.equal(new Set(secrets).size, 5);
        for (const value of secrets) {
            assert.match(value, /^[a-f0-9]{64}$/);
            assert.ok(!first.stdout.includes(value));
        }
        assert.equal((await stat(path.join(directory, '.env'))).mode & 0o777, 0o600);
        await run(process.execPath, [script, 'prepare', '--directory', directory]);
        assert.equal(await readFile(path.join(directory, '.env'), 'utf8'), contents);
        assert.equal(JSON.parse(await readFile(path.join(directory, 'runtime.json'))).sandboxProvider, 'none');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('prepare rejects model URLs containing credentials before writing secrets', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rakazo-stack-'));
    try {
        await assert.rejects(run(process.execPath, [script, 'prepare', '--directory', directory, '--model-url', 'https://user:password@example.test/v1']), error => error.code === 1 && error.stderr.includes('must not contain credentials') && !error.stderr.includes('user:password'));
        await assert.rejects(stat(path.join(directory, '.env')), { code: 'ENOENT' });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
