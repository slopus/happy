import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function boundaryFile(gitDirectory: string, key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('checkpoint retention boundary binding is invalid');
    return join(gitDirectory, 'gc-boundaries', `${key}.json`);
}

/** A deleted intermediate record removes provenance: older restores must require explicit inclusion. */
export async function readCheckpointRetentionBoundary(gitDirectory: string, key: string): Promise<number | null> {
    try {
        const marker = JSON.parse(await readFile(boundaryFile(gitDirectory, key), 'utf8')) as { schemaVersion?: unknown; newestPrunedAt?: unknown };
        if (marker.schemaVersion !== 1 || !Number.isSafeInteger(marker.newestPrunedAt) || (marker.newestPrunedAt as number) < 0) {
            throw new Error('checkpoint retention boundary is invalid');
        }
        return marker.newestPrunedAt as number;
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
    }
}

/** Called under the store lock; persist the conservative barrier before deleting any refs. */
export async function recordCheckpointRetentionBoundary(gitDirectory: string, key: string, newestPrunedAt: number): Promise<void> {
    const previous = await readCheckpointRetentionBoundary(gitDirectory, key);
    if (previous !== null && previous >= newestPrunedAt) return;
    const file = boundaryFile(gitDirectory, key);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
            await handle.writeFile(JSON.stringify({ schemaVersion: 1, newestPrunedAt }));
            await handle.sync();
        } finally { await handle.close(); }
        await rename(temporary, file);
        const directory = await open(dirname(file), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
}
