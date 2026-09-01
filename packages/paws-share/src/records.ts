import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ShareSource = 'paws' | 'codex' | 'claude-code';

export type ShareRecord = {
    recordId: string;
    serverUrl: string;
    publicId: string;
    shareId: string;
    managementToken: string;
    source: ShareSource;
    title: string;
    createdAt: string;
    expiresAt: string;
};

export type PublicShareRecord = Omit<ShareRecord, 'managementToken'>;

type RecordFile = {
    version: 1;
    records: ShareRecord[];
};

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function defaultShareHome(environment: NodeJS.ProcessEnv = process.env): string {
    return environment.PAWS_SHARE_HOME || join(homedir(), '.paws-share');
}

export class ShareRecordStore {
    readonly recordPath: string;
    readonly lockPath: string;

    constructor(readonly home = defaultShareHome()) {
        this.recordPath = join(home, 'shares.json');
        this.lockPath = join(home, 'shares.lock');
    }

    async load(): Promise<ShareRecord[]> {
        let raw: string;
        try {
            raw = await readFile(this.recordPath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
        }
        const parsed = JSON.parse(raw) as RecordFile;
        if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
            throw new Error('Unsupported Paws Share record format');
        }
        return parsed.records;
    }

    async save(record: ShareRecord): Promise<void> {
        await this.withWriteLock(async () => {
            const records = await this.load();
            const index = records.findIndex((candidate) => candidate.recordId === record.recordId);
            if (index >= 0) records[index] = record;
            else records.push(record);
            await this.write({ version: 1, records });
        });
    }

    async get(recordId: string): Promise<ShareRecord | null> {
        return (await this.load()).find((record) => record.recordId === recordId || record.publicId === recordId) ?? null;
    }

    async remove(recordId: string): Promise<void> {
        await this.withWriteLock(async () => {
            const records = (await this.load()).filter((record) => record.recordId !== recordId && record.publicId !== recordId);
            await this.write({ version: 1, records });
        });
    }

    async list(): Promise<PublicShareRecord[]> {
        return (await this.load()).map(({ managementToken: _managementToken, ...record }) => record);
    }

    private async withWriteLock<T>(callback: () => Promise<T>): Promise<T> {
        await mkdir(this.home, { recursive: true, mode: 0o700 });
        await chmod(this.home, 0o700);
        const deadline = Date.now() + LOCK_WAIT_MS;
        let handle;
        while (!handle) {
            try {
                handle = await open(this.lockPath, 'wx', 0o600);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                const lockStat = await stat(this.lockPath).catch(() => null);
                if (lockStat && lockStat.mtimeMs < Date.now() - LOCK_STALE_MS) {
                    await unlink(this.lockPath).catch(() => undefined);
                    continue;
                }
                if (Date.now() >= deadline) throw new Error('Timed out waiting for the Paws Share management record lock');
                await delay(20);
            }
        }
        try {
            return await callback();
        } finally {
            await handle.close();
            await unlink(this.lockPath).catch(() => undefined);
        }
    }

    private async write(file: RecordFile): Promise<void> {
        await mkdir(this.home, { recursive: true, mode: 0o700 });
        await chmod(this.home, 0o700);
        const temporaryPath = `${this.recordPath}.tmp-${process.pid}-${randomUUID()}`;
        const payload = `${JSON.stringify(file, null, 2)}\n`;
        const handle = await open(temporaryPath, 'wx', 0o600);
        try {
            await handle.writeFile(payload, 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
        try {
            await rename(temporaryPath, this.recordPath);
            await chmod(this.recordPath, 0o600);
        } catch (error) {
            await unlink(temporaryPath).catch(() => undefined);
            throw error;
        }
    }
}
