import { Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { filesMock, resetStorage } = vi.hoisted(() => {
    const state = {
        local: true,
        objectStorageConfigured: true,
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
        removeObject: vi.fn(async (_bucket: string, key: string) => { state.objects.delete(key); }),
        copyObject: vi.fn(async (_bucket: string, destination: string, source: string) => {
            const sourceKey = source.replace(/^\/bucket\//, '');
            const value = state.objects.get(sourceKey);
            if (!value) throw new Error('missing');
            state.objects.set(destination, value);
        }),
    };
    const filesMock = {
        s3client,
        s3bucket: 'bucket',
        isLocalStorage: vi.fn(() => state.local),
        isObjectStorageConfigured: vi.fn(() => state.objectStorageConfigured),
        getLocalFilesDir: vi.fn(() => '/tmp/paws-share-storage'),
        putLocalFile: vi.fn(async (key: string, value: Buffer) => { state.objects.set(key, value); }),
        readLocalFile: vi.fn((key: string) => state.objects.get(key) ?? null),
        localFileExists: vi.fn((key: string) => state.objects.has(key)),
        deleteFilePrefix: vi.fn(async (prefix: string) => {
            for (const key of state.objects.keys()) {
                if (key.startsWith(`${prefix}/`)) state.objects.delete(key);
            }
        }),
        deleteFile: vi.fn(async (key: string) => { state.objects.delete(key); }),
        copyFile: vi.fn(async (source: string, destination: string) => {
            const value = state.objects.get(source);
            if (!value) throw new Error('missing');
            state.objects.set(destination, value);
        }),
        __state: state,
    };
    const resetStorage = () => {
        state.local = true;
        state.objectStorageConfigured = true;
        state.objects.clear();
        delete process.env.PUBLIC_SHARE_LOCAL_STORAGE;
        process.env.NODE_ENV = 'test';
        vi.clearAllMocks();
    };
    return { filesMock, resetStorage };
});

vi.mock('@/storage/files', () => filesMock);

import {
    buildPublicShareStoragePath,
    copyPublicShareAsset,
    deletePublicShareAsset,
    deletePublicShareGeneration,
    getPublicShareDownloadSource,
    publicShareAssetExists,
    putPublicShareAsset,
    readPublicShareAssetBytes,
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

    it.each([true, false])('reads exact share bytes through a bounded storage API (local=%s)', async (local) => {
        filesMock.__state.local = local;
        const storagePath = buildPublicShareStoragePath('share_1', 'generation-1', 'asset_1');
        filesMock.__state.objects.set(storagePath, Buffer.from('hello'));

        await expect(readPublicShareAssetBytes(storagePath, 5)).resolves.toEqual(Buffer.from('hello'));
        await expect(readPublicShareAssetBytes(storagePath, 4)).rejects.toThrow('Public share asset exceeds byte limit');
    });

    it('fails every public-share object operation closed in production without explicit local opt-in', async () => {
        process.env.NODE_ENV = 'production';
        filesMock.__state.local = true;
        const storagePath = buildPublicShareStoragePath('share_1', 'generation-1', 'asset_1');

        await expect(putPublicShareAsset(storagePath, Buffer.from('hello'))).rejects.toThrow('Public share object storage is required');
        await expect(copyPublicShareAsset(storagePath, `${storagePath}-copy`)).rejects.toThrow('Public share object storage is required');
        await expect(readPublicShareAssetBytes(storagePath, 5)).rejects.toThrow('Public share object storage is required');
        await expect(getPublicShareDownloadSource(storagePath)).rejects.toThrow('Public share object storage is required');
        await expect(publicShareAssetExists(storagePath, 5)).rejects.toThrow('Public share object storage is required');
        await expect(deletePublicShareAsset(storagePath)).rejects.toThrow('Public share object storage is required');
        await expect(deletePublicShareGeneration('share_1', 'generation-1')).rejects.toThrow('Public share object storage is required');

        process.env.PUBLIC_SHARE_LOCAL_STORAGE = 'enabled';
        await expect(putPublicShareAsset(storagePath, Buffer.from('hello'))).resolves.toBeUndefined();
        await expect(readPublicShareAssetBytes(storagePath, 5)).resolves.toEqual(Buffer.from('hello'));
    });

    it('fails closed when S3 mode is selected with incomplete object-storage configuration', async () => {
        process.env.NODE_ENV = 'production';
        filesMock.__state.local = false;
        filesMock.__state.objectStorageConfigured = false;
        const storagePath = buildPublicShareStoragePath('share_1', 'generation-1', 'asset_1');

        await expect(putPublicShareAsset(storagePath, Buffer.from('hello'))).rejects.toThrow('Public share object storage is required');
        await expect(readPublicShareAssetBytes(storagePath, 5)).rejects.toThrow('Public share object storage is required');
    });

    it.each([true, false])('copies a share asset inside the configured storage backend (local=%s)', async (local) => {
        filesMock.__state.local = local;
        const source = buildPublicShareStoragePath('share_1', 'active-generation', 'cover_1');
        const destination = buildPublicShareStoragePath('share_1', 'pending-generation', 'cover_1');
        filesMock.__state.objects.set(source, Buffer.from('cover'));

        await copyPublicShareAsset(source, destination);

        expect(filesMock.__state.objects.get(destination)).toEqual(Buffer.from('cover'));
        expect(filesMock.copyFile).toHaveBeenCalledWith(source, destination);
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

    it('deletes one stale imported object without removing sibling generation assets', async () => {
        const importedPath = buildPublicShareStoragePath('share_1', 'generation-1', 'cover_1');
        const attachmentPath = buildPublicShareStoragePath('share_1', 'generation-1', 'asset_2');
        filesMock.__state.objects.set(importedPath, Buffer.from('cover'));
        filesMock.__state.objects.set(attachmentPath, Buffer.from('attachment'));

        await deletePublicShareAsset(importedPath);

        expect(filesMock.__state.objects.has(importedPath)).toBe(false);
        expect(filesMock.__state.objects.has(attachmentPath)).toBe(true);
    });
});
