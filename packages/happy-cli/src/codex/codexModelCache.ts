import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// This is the native catalog, never auth/config or a Paws capability response.
// Keep the native timestamp and version verbatim: Codex still checks its own
// client_version before using the file. A mismatch is an ordinary cache miss.
const TTL = 300_000;
const MAX_BYTES = 8 * 1024 * 1024;
async function catalog(path: string, now: number) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
    if (!file) return;
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_BYTES) return;
        const bytes = Buffer.alloc(MAX_BYTES + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > MAX_BYTES) return;
        const raw = bytes.subarray(0, bytesRead), value = JSON.parse(raw.toString('utf8'));
        const at = typeof value.fetched_at === 'string' ? Date.parse(value.fetched_at) : NaN;
        if (!Number.isFinite(at) || at > now || now - at >= TTL || typeof value.client_version !== 'string' || !value.client_version || !Array.isArray(value.models)) return;
        return { raw, at };
    } catch { return; } finally { await file.close(); }
}

export class CodexModelCache {
    private readonly directory: string;
    constructor(root: string, profileId: string, accountId: string) {
        this.directory = join(root, 'model-catalogs', createHash('sha256').update(JSON.stringify([profileId, accountId])).digest('hex'));
    }
    async restore(home: string, now = Date.now()): Promise<void> {
        try {
            const names = (await readdir(this.directory)).filter(name => /^\d{13}-[a-f0-9]{64}\.json$/.test(name)).sort().reverse();
            for (const name of names.slice(0, 128)) {
                const value = await catalog(join(this.directory, name), now);
                if (!value) continue;
                await writeFile(join(home, 'models_cache.json'), value.raw, { mode: 0o600, flag: 'wx' });
                return;
            }
        } catch { /* Cache availability must never affect launching/authentication. */ }
    }
    async publish(home: string, now = Date.now()): Promise<void> {
        try {
            const value = await catalog(join(home, 'models_cache.json'), now);
            if (!value) return;
            await mkdir(this.directory, { recursive: true, mode: 0o700 });
            // Immutable content-addressed files prevent an old/concurrent worker
            // from overwriting a newer catalog. Link only complete private files.
            const name = `${value.at}-${createHash('sha256').update(value.raw).digest('hex')}.json`;
            const temporary = join(this.directory, `.${randomUUID()}.tmp`);
            try {
                await writeFile(temporary, value.raw, { mode: 0o600, flag: 'wx' });
                await link(temporary, join(this.directory, name)).catch(error => { if (error.code !== 'EEXIST') throw error; });
            } finally { await rm(temporary, { force: true }); }
            for (const old of await readdir(this.directory)) {
                if (/^\d{13}-[a-f0-9]{64}\.json$/.test(old) && now - Number(old.slice(0, 13)) >= TTL) await rm(join(this.directory, old), { force: true });
            }
        } catch { /* Opportunistic metadata only; do not log provider contents. */ }
    }
}
