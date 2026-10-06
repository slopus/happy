/** Real child-process checks for the restricted Codex network environment. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRestrictedCodex } from './restrictedCodex';
import { readCodexCapabilities } from './serviceCapabilities';

const roots: string[] = [];
afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function runtimeFixture() {
    const root = await mkdtemp(join(tmpdir(), 'restricted-codex-network-'));
    roots.push(root);
    const binary = join(root, 'runtime');
    await writeFile(binary, `#!/usr/bin/env node
const fs = require('fs'), rl = require('readline');
if (process.argv.includes('--version')) { console.log('codex-cli 0.159.3'); process.exit(0); }
fs.writeFileSync(process.cwd() + '/observed-env.json', JSON.stringify(process.env));
const send = value => console.log(JSON.stringify(value));
rl.createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (request.id == null) return;
    let result = {};
    if (request.method === 'model/list') result = { data: [], nextCursor: null };
    if (request.method === 'thread/start') result = { thread: { id: 'thread' }, model: 'gpt-6-astra' };
    send({ id: request.id, result });
    if (request.method === 'turn/start') {
        send({ method: 'item/agentMessage/delta', params: { delta: 'ok' } });
        send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    }
});
`, { mode: 0o700 });
    return { root, binary, home: join(root, 'private-codex') };
}

describe('restricted Codex child network environment', () => {
    for (const operation of ['capability discovery', 'chat execution'] as const) {
        it(`${operation} honors only the explicit Codex proxy while retaining credential isolation`, async () => {
            const fixture = await runtimeFixture();
            vi.stubEnv('OPENAI_API_KEY', 'must-not-reach-child');
            vi.stubEnv('ANTHROPIC_API_KEY', 'must-not-reach-child');
            vi.stubEnv('HTTP_PROXY', 'http://ambient.invalid:1');
            vi.stubEnv('HTTPS_PROXY', 'http://ambient.invalid:2');
            vi.stubEnv('ALL_PROXY', 'http://ambient.invalid:3');
            for (const [primary, fallback, expected] of [
                ['http://127.0.0.1:10802', 'http://127.0.0.1:10999', 'http://127.0.0.1:10802'],
                ['', 'http://127.0.0.1:10999', 'http://127.0.0.1:10999'],
                ['', '', undefined],
            ]) {
                vi.stubEnv('HAPPY_CODEX_PROXY_URL', primary);
                vi.stubEnv('CODEX_PROXY_URL', fallback);
                const signal = new AbortController().signal;
                if (operation === 'capability discovery') {
                    await readCodexCapabilities({ machineId: 'machine', engine: 'codex', accountRef: { kind: 'codex-profile', id: 'profile' } }, fixture.binary, fixture.home, fixture.root, signal);
                } else {
                    await expect(runRestrictedCodex(fixture.binary, fixture.home, fixture.root, [{ role: 'user', text: 'hello' }], signal, () => undefined)).resolves.toBe('ok');
                }
                const observed = JSON.parse(await readFile(join(fixture.root, 'observed-env.json'), 'utf8'));
                expect(observed).toMatchObject({ HOME: fixture.root, TMPDIR: fixture.root, CODEX_HOME: fixture.home });
                for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) expect(observed[key]).toBe(expected);
                for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ALL_PROXY', 'HAPPY_CODEX_PROXY_URL', 'CODEX_PROXY_URL']) expect(observed[key]).toBeUndefined();
            }
        });
    }
});
