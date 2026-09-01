import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
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

export function defaultShareHome(environment: NodeJS.ProcessEnv = process.env): string {
    return environment.PAWS_SHARE_HOME || join(homedir(), '.paws-share');
}

export class ShareRecordStore {
    readonly recordPath: string;

    constructor(readonly home = defaultShareHome()) {
        this.recordPath = join(home, 'shares.json');
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
        const records = await this.load();
        const index = records.findIndex((candidate) => candidate.recordId === record.recordId);
        if (index >= 0) records[index] = record;
        else records.push(record);
        await this.write({ version: 1, records });
    }

    async get(recordId: string): Promise<ShareRecord | null> {
        return (await this.load()).find((record) => record.recordId === recordId || record.publicId === recordId) ?? null;
    }

    async remove(recordId: string): Promise<void> {
        const records = (await this.load()).filter((record) => record.recordId !== recordId && record.publicId !== recordId);
        await this.write({ version: 1, records });
    }

    async list(): Promise<PublicShareRecord[]> {
        return (await this.load()).map(({ managementToken: _managementToken, ...record }) => record);
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
