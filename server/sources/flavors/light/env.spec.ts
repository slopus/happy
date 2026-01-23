import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyLightDefaultEnv, ensureHandyMasterSecret } from './env';

describe('light env helpers', () => {
    it('applyLightDefaultEnv fills defaults without overriding explicit values', () => {
        const env: NodeJS.ProcessEnv = {
            PORT: '4000',
            DATABASE_URL: 'file:/custom.sqlite',
            PUBLIC_URL: 'http://example.com/',
            HAPPY_SERVER_LIGHT_DATA_DIR: '/custom/data',
            HAPPY_SERVER_LIGHT_FILES_DIR: '/custom/files',
        };

        applyLightDefaultEnv(env, { homedir: '/home/ignored' });

        expect(env.HAPPY_SERVER_LIGHT_DATA_DIR).toBe('/custom/data');
        expect(env.HAPPY_SERVER_LIGHT_FILES_DIR).toBe('/custom/files');
        expect(env.DATABASE_URL).toBe('file:/custom.sqlite');
        expect(env.PUBLIC_URL).toBe('http://example.com');
    });

    it('applyLightDefaultEnv derives defaults from homedir and PORT when missing', () => {
        const env: NodeJS.ProcessEnv = { PORT: '4000' };
        applyLightDefaultEnv(env, { homedir: '/home/test' });

        expect(env.HAPPY_SERVER_LIGHT_DATA_DIR).toBe('/home/test/.happy/server-light');
        expect(env.HAPPY_SERVER_LIGHT_FILES_DIR).toBe('/home/test/.happy/server-light/files');
        expect(env.DATABASE_URL).toBe('file:///home/test/.happy/server-light/happy-server-light.sqlite');
        expect(env.PUBLIC_URL).toBe('http://localhost:4000');
    });

    it('applyLightDefaultEnv falls back to default port when PORT is invalid', () => {
        const env: NodeJS.ProcessEnv = { PORT: 'oops' };
        applyLightDefaultEnv(env, { homedir: '/home/test' });
        expect(env.PUBLIC_URL).toBe('http://localhost:3005');
    });

    it('ensureHandyMasterSecret persists a generated secret and reuses it', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happy-server-light-'));
        try {
            const env: NodeJS.ProcessEnv = { HAPPY_SERVER_LIGHT_DATA_DIR: dir };
            await ensureHandyMasterSecret(env, { dataDir: dir });
            expect(typeof env.HANDY_MASTER_SECRET).toBe('string');
            const first = env.HANDY_MASTER_SECRET as string;
            expect(first.length).toBeGreaterThan(0);

            // New env should pick up persisted value.
            const env2: NodeJS.ProcessEnv = { HAPPY_SERVER_LIGHT_DATA_DIR: dir };
            await ensureHandyMasterSecret(env2, { dataDir: dir });
            expect(env2.HANDY_MASTER_SECRET).toBe(first);

            const onDisk = (await readFile(join(dir, 'handy-master-secret.txt'), 'utf-8')).trim();
            expect(onDisk).toBe(first);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('ensureHandyMasterSecret ensures the data directory exists even when secret is already set', async () => {
        const base = await mkdtemp(join(tmpdir(), 'happy-server-light-'));
        const dir = join(base, 'data');
        try {
            const env: NodeJS.ProcessEnv = { HAPPY_SERVER_LIGHT_DATA_DIR: dir, HANDY_MASTER_SECRET: 'pre-set' };
            await ensureHandyMasterSecret(env, { dataDir: dir });
            expect((await stat(dir)).isDirectory()).toBe(true);
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });
});
