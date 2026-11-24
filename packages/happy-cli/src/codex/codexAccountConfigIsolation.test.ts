/** Optional native regression: no credentials or inference turns are used. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CodexAppServerClient } from './codexAppServerClient';
import { assertCodexAccountConfig, CODEX_ACCOUNT_PROVIDER } from './codexAccountConfig';
import { prepareCodexHomeWithAuth } from './codexHome';

it.runIf(Boolean(process.env.PAWS_CODEX_INTEGRATION_BIN))('keeps a host home project catalog out of an isolated account process while retaining the real thread directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paws-account-config-isolation-'));
    const project = join(root, 'host-home');
    const sourceHome = join(project, '.codex');
    const accountHome = join(root, 'account-home');
    await mkdir(sourceHome, { recursive: true });
    const original = `model_catalog_json = ${JSON.stringify(join(project, 'missing-host-catalog.json'))}\n`;
    await writeFile(join(sourceHome, 'config.toml'), original);
    await prepareCodexHomeWithAuth('{}', { sourceHome, createTempDir: () => accountHome, isolateModelConfiguration: true });
    const client = new CodexAppServerClient(undefined, { type: 'spawn' }, {
        ...process.env, CODEX_HOME: accountHome, HAPPY_CODEX_ACCOUNT_PROFILE_ID: 'synthetic-isolation-probe',
        HAPPY_CODEX_PATH: process.env.PAWS_CODEX_INTEGRATION_BIN,
    }, undefined, project);
    try {
        await client.connect();
        const config = await client.readEffectiveModelConfiguration();
        expect(config.model_catalog_json).toBeNull();
        expect(() => assertCodexAccountConfig(config)).not.toThrow();
        expect(config.model_provider).toBe(CODEX_ACCOUNT_PROVIDER);
        const started = await client.startThread({ cwd: project, sandbox: 'read-only', approvalPolicy: 'never' });
        const { thread } = await client.readThread({ threadId: started.threadId, includeTurns: false });
        expect(thread.cwd).toBe(project);
        expect(thread.turns).toEqual([]);
        expect(await readFile(join(sourceHome, 'config.toml'), 'utf8')).toBe(original);
    } finally {
        await client.disconnect({ waitForExit: true });
        await rm(root, { recursive: true, force: true });
    }
}, 30_000);
