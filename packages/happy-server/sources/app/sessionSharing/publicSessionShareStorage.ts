import {
    deleteFilePrefix,
    isLocalStorage,
    localFileExists,
    putLocalFile,
    readLocalFile,
    s3bucket,
    s3client,
} from '@/storage/files';

const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]+$/;

function assertSafeIdentifier(value: string): void {
    if (!SAFE_IDENTIFIER.test(value)) {
        throw new Error('Invalid share storage identifier');
    }
}

export function buildPublicShareStoragePath(shareId: string, generation: string, assetId: string): string {
    assertSafeIdentifier(shareId);
    assertSafeIdentifier(generation);
    assertSafeIdentifier(assetId);
    return `private/session-shares/${shareId}/${generation}/${assetId}`;
}

export async function putPublicShareAsset(storagePath: string, data: Buffer): Promise<void> {
    if (isLocalStorage()) return putLocalFile(storagePath, data);
    await s3client.putObject(s3bucket, storagePath, data, data.length);
}

export async function publicShareAssetExists(storagePath: string, expectedSize: number): Promise<boolean> {
    if (isLocalStorage()) {
        if (!localFileExists(storagePath)) return false;
        return readLocalFile(storagePath)?.length === expectedSize;
    }
    try {
        const stat = await s3client.statObject(s3bucket, storagePath);
        return stat.size === expectedSize;
    } catch {
        return false;
    }
}

export async function getPublicShareDownloadSource(storagePath: string): Promise<
    | { kind: 'buffer'; data: Buffer }
    | { kind: 'stream'; data: NodeJS.ReadableStream }
> {
    if (isLocalStorage()) {
        const data = readLocalFile(storagePath);
        if (!data) throw new Error('Public share asset not found');
        return { kind: 'buffer', data };
    }
    return { kind: 'stream', data: await s3client.getObject(s3bucket, storagePath) };
}

export async function deletePublicShareGeneration(shareId: string, generation: string): Promise<void> {
    assertSafeIdentifier(shareId);
    assertSafeIdentifier(generation);
    await deleteFilePrefix(`private/session-shares/${shareId}/${generation}`);
}
