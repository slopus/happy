import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTemporaryDirectory, removeTemporaryDirectory } from './testSupport/temporaryDirectory';
import { ShareRecordStore, type ShareRecord } from './records';

const temporaryDirectories: string[] = [];

function record(overrides: Partial<ShareRecord> = {}): ShareRecord {
    return {
        recordId: 'record-1',
        serverUrl: 'https://paws.build',
        publicId: 'public-1',
        shareId: 'share-1',
        managementToken: Buffer.alloc(32, 7).toString('base64url'),
        source: 'codex',
        title: 'Drawing session',
        createdAt: '2026-09-01T00:00:00.000Z',
        expiresAt: '2026-11-30T00:00:00.000Z',
        ...overrides,
    };
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory));
});

describe('ShareRecordStore', () => {
    it('writes records atomically with owner-only permissions', async () => {
        const home = await createTemporaryDirectory('paws-share-records-');
        temporaryDirectories.push(home);
        const store = new ShareRecordStore(home);

        await store.save(record());

        const recordPath = join(home, 'shares.json');
        expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
        expect(JSON.parse(await readFile(recordPath, 'utf8')).records).toHaveLength(1);
        expect((await stat(home)).isDirectory()).toBe(true);
        expect((await stat(home)).mode & 0o077).toBe(0);
    });

    it('replaces one record without losing unrelated records or leaving temporary files', async () => {
        const home = await createTemporaryDirectory('paws-share-records-');
        temporaryDirectories.push(home);
        const store = new ShareRecordStore(home);
        await store.save(record());
        await store.save(record({ recordId: 'record-2', publicId: 'public-2', shareId: 'share-2' }));

        await store.save(record({ title: 'Updated drawing session' }));

        expect((await store.load()).map((item) => item.title)).toEqual(['Updated drawing session', 'Drawing session']);
        expect((await stat(join(home, 'shares.json'))).mode & 0o777).toBe(0o600);
        await expect(stat(join(home, 'shares.json.tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('returns public records without exposing management tokens', async () => {
        const home = await createTemporaryDirectory('paws-share-records-');
        temporaryDirectories.push(home);
        const store = new ShareRecordStore(home);
        const privateRecord = record();
        await store.save(privateRecord);

        const publicRecords = await store.list();

        expect(publicRecords).toEqual([{ ...privateRecord, managementToken: undefined }]);
        expect(JSON.stringify(publicRecords)).not.toContain(privateRecord.managementToken);
    });

    it('repairs an existing permissive home before writing records', async () => {
        const home = await createTemporaryDirectory('paws-share-records-');
        temporaryDirectories.push(home);
        await mkdir(join(home, 'nested'), { recursive: true });
        const store = new ShareRecordStore(home);

        await store.save(record());

        expect((await stat(home)).mode & 0o077).toBe(0);
    });
});
