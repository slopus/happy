import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { homedir } from 'node:os';
import { resolveLightPublicUrl } from './env';

/**
 * Lightweight file storage for happy-server "light" flavor.
 *
 * In production (full flavor), happy-server uses S3/Minio for public files.
 * In light flavor, we store files on disk and serve them via `GET /files/*`.
 */

export function resolveLightPublicFilesDir(env: NodeJS.ProcessEnv): string {
    return env.HAPPY_SERVER_LIGHT_FILES_DIR?.trim()
        ? env.HAPPY_SERVER_LIGHT_FILES_DIR.trim()
        : join(homedir(), '.happy', 'server-light', 'files');
}

export async function ensureLightFilesDir(env: NodeJS.ProcessEnv): Promise<void> {
    await mkdir(resolveLightPublicFilesDir(env), { recursive: true });
}

export function getLightPublicBaseUrl(env: NodeJS.ProcessEnv): string {
    return resolveLightPublicUrl(env);
}

export function normalizePublicPath(path: string): string {
    const p = normalize(path).replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = p.split('/').filter(Boolean);
    if (parts.some((part: string) => part === '..')) {
        throw new Error('Invalid path');
    }
    if (p.includes(':') || p.startsWith('/')) {
        throw new Error('Invalid path');
    }
    return parts.join('/');
}

export function getLightPublicUrl(env: NodeJS.ProcessEnv, path: string): string {
    const safe = normalizePublicPath(path);
    return `${getLightPublicBaseUrl(env)}/files/${encodeURI(safe)}`;
}

export async function writeLightPublicFile(env: NodeJS.ProcessEnv, path: string, data: Uint8Array): Promise<void> {
    const safe = normalizePublicPath(path);
    const abs = join(resolveLightPublicFilesDir(env), safe);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, data);
}

export async function readLightPublicFile(env: NodeJS.ProcessEnv, path: string): Promise<Uint8Array> {
    const safe = normalizePublicPath(path);
    const abs = join(resolveLightPublicFilesDir(env), safe);
    return await readFile(abs);
}
