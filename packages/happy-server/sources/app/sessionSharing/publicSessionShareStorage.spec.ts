import { Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { filesMock, resetStorage } = vi.hoisted(() => {
    const state = {
        local: true,
        objects: new Map<string, Buffer>(),
    };
    const s3client = {
        putObject: vi.fn(async (_bucket: string, key: string, value: Buffer) => { state.objects.set(key, value); }),
        getObject: vi.fn(async (_bucket: string, key: string) => {
            const value = state.objects.get(key);
            if (!value) throw new Error('missing');
            return Readable.from(value);
        }),
        statObject: vi.fn(async (_bucket: string, key: string) => {
            if (!state.objects.has(key)) throw new Error('missing');
            return { size: state.objects.get(key)!.length };
        }),
        listObjects: vi.fn(),
        removeObjects: vi.fn(async () => undefined),
    };
    const filesMock = {
        s3client,
        s3bucket: 'bucket',
        isLocalStorage: vi.fn(() => state.local),
        getLocalFilesDir: vi.fn(() => '/tmp/paws-share-storage'),
        putLocalFile: vi.fn(async (key: string, value: Buffer) => { state.objects.set(key, value); }),
        readLocalFile: vi.fn((key: string) => state.objects.get(key) ?? null),
        localFileExists: vi.fn((key: string) => state.objects.has(key)),
        deleteFilePrefix: vi.fn(async (prefix: string) => {
            for (const key of state.objects.keys()) {
                if (key.startsWith(`${prefix}/`)) state.objects.delete(key);
            }
        }),
        __state: state,
    };
    const resetStorage = () => {
        state.local = true;
        state.objects.clear();
        vi.clearAllMocks();
    };
    return { filesMock, resetStorage };
});

vi.mock('@/storage/files', () => filesMock);

import {
    buildPublicShareStoragePath,
    deletePublicShareGeneration,
    getPublicShareDownloadSource,
    publicShareAssetExists,
    putPublicShareAsset,
} from './publicSessionShareStorage';

describe('publicSessionShareStorage', () => {
    beforeEach(resetStorage);

    it('builds a generation-contained object path and rejects unsafe identifiers', () => {
        expect(buildPublicShareStoragePath('share_1', 'generation-1', 'asset_1')).toBe(
            'private/session-shares/share_1/generation-1/asset_1',
        );
        expect(() => buildPublicShareStoragePath('../share', 'generation-1', 'asset_1')).toThrow('Invalid share storage identifier');
        expect(() => buildPublicShareStoragePath('share_1', 'generation/1', 'asset_1')).toThrow('Invalid share storage identifier');
    });

    it('writes and resolves local share assets without exposing a filesystem path', async () => {
        const storagePath = buildPublicShareStoragePath('share_1', 'generation-1', 'asset_1');
        await putPublicShareAsset(storagePath, Buffer.from('hello'));
        expect(await publicShareAssetExists(storagePath, 5)).toBe(true);
        expect(await getPublicShareDownloadSource(storagePath)).toEqual({ kind: 'buffer', data: Buffer.from('hello') });
    });

    it('keeps S3 objects behind the revocation-aware server proxy', async () => {
        filesMock.__state.local = false;
        const storagePath = buildPublicShareStoragePath('share_1', 'generation-1', 'asset_1');
        await putPublicShareAsset(storagePath, Buffer.from('hello'));
        expect(await publicShareAssetExists(storagePath, 5)).toBe(true);
        expect(await publicShareAssetExists(storagePath, 4)).toBe(false);
        const source = await getPublicShareDownloadSource(storagePath);
        expect(source.kind).toBe('stream');
        expect(filesMock.s3client.getObject).toHaveBeenCalledWith('bucket', storagePath);
        expect(filesMock.s3client.putObject).toHaveBeenCalledWith('bucket', storagePath, Buffer.from('hello'), 5);
    });

    it('deletes only the requested generation prefix', async () => {
        const oldPath = buildPublicShareStoragePath('share_1', 'old-generation', 'asset_1');
        const activePath = buildPublicShareStoragePath('share_1', 'active-generation', 'asset_2');
        filesMock.__state.objects.set(oldPath, Buffer.from('old'));
        filesMock.__state.objects.set(activePath, Buffer.from('active'));

        await deletePublicShareGeneration('share_1', 'old-generation');

        expect(filesMock.__state.objects.has(oldPath)).toBe(false);
        expect(filesMock.__state.objects.has(activePath)).toBe(true);
    });
});
