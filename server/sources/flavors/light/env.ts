import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir as defaultHomedir } from 'node:os';
import { pathToFileURL } from 'node:url';

export type LightEnv = NodeJS.ProcessEnv;

export function resolveLightDataDir(env: LightEnv, opts?: { homedir?: string }): string {
    const fromEnv = env.HAPPY_SERVER_LIGHT_DATA_DIR?.trim();
    if (fromEnv) {
        return fromEnv;
    }
    const home = opts?.homedir ?? defaultHomedir();
    return join(home, '.happy', 'server-light');
}

export function resolveLightFilesDir(env: LightEnv, dataDir: string): string {
    const fromEnv = env.HAPPY_SERVER_LIGHT_FILES_DIR?.trim();
    if (fromEnv) {
        return fromEnv;
    }
    return join(dataDir, 'files');
}

export function resolveLightDatabaseUrl(env: LightEnv, dataDir: string): string {
    const fromEnv = env.DATABASE_URL?.trim();
    if (fromEnv) {
        return fromEnv;
    }
    const dbPath = join(dataDir, 'happy-server-light.sqlite');
    return pathToFileURL(dbPath).toString();
}

export function resolveLightPublicUrl(env: LightEnv): string {
    const fromEnv = env.PUBLIC_URL?.trim();
    if (fromEnv) {
        return fromEnv.replace(/\/+$/, '');
    }
    const parsed = env.PORT ? parseInt(env.PORT, 10) : NaN;
    const port = Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 3005;
    return `http://localhost:${port}`;
}

export function applyLightDefaultEnv(env: LightEnv, opts?: { homedir?: string }): void {
    const dataDir = resolveLightDataDir(env, opts);
    const filesDir = resolveLightFilesDir(env, dataDir);

    env.HAPPY_SERVER_LIGHT_DATA_DIR = dataDir;
    env.HAPPY_SERVER_LIGHT_FILES_DIR = filesDir;

    env.DATABASE_URL = resolveLightDatabaseUrl(env, dataDir);
    env.PUBLIC_URL = resolveLightPublicUrl(env);
}

export async function ensureHandyMasterSecret(env: LightEnv, opts?: { dataDir?: string; homedir?: string }): Promise<void> {
    const dataDir = opts?.dataDir ?? resolveLightDataDir(env, { homedir: opts?.homedir });
    await mkdir(dataDir, { recursive: true });

    if (env.HANDY_MASTER_SECRET && env.HANDY_MASTER_SECRET.trim()) {
        return;
    }
    const secretPath = join(dataDir, 'handy-master-secret.txt');

    try {
        const existing = (await readFile(secretPath, 'utf-8')).trim();
        if (existing) {
            env.HANDY_MASTER_SECRET = existing;
            return;
        }
    } catch {
        // ignore - will create below
    }

    await mkdir(dirname(secretPath), { recursive: true });
    const generated = randomBytes(32).toString('base64url');
    try {
        await writeFile(secretPath, generated, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
        env.HANDY_MASTER_SECRET = generated;
        return;
    } catch (err: any) {
        if (err?.code !== 'EEXIST') {
            throw err;
        }
    }

    // Another process likely created the file while we were racing to initialize it.
    const existing = (await readFile(secretPath, 'utf-8')).trim();
    if (!existing) {
        throw new Error(`handy-master-secret.txt exists but is empty: ${secretPath}`);
    }
    env.HANDY_MASTER_SECRET = existing;
}
