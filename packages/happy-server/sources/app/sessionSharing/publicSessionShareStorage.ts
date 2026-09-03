import {
    copyFile,
    deleteFile,
    deleteFilePrefix,
    isLocalStorage,
    isObjectStorageConfigured,
    localFileExists,
    putLocalFile,
    readLocalFile,
    s3bucket,
    s3client,
} from '@/storage/files';

const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]+$/;
const LOCAL_STORAGE_OPT_IN = 'enabled';

function assertPublicShareStorageAvailable(): void {
    if (process.env.NODE_ENV !== 'production') return;
    const explicitLocal = isLocalStorage()
        && process.env.PUBLIC_SHARE_LOCAL_STORAGE === LOCAL_STORAGE_OPT_IN;
    if (!explicitLocal && (isLocalStorage() || !isObjectStorageConfigured())) {
        throw new Error('Public share object storage is required in production');
    }
}

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
    assertPublicShareStorageAvailable();
    if (isLocalStorage()) return putLocalFile(storagePath, data);
    await s3client.putObject(s3bucket, storagePath, data, data.length);
}

export async function copyPublicShareAsset(sourcePath: string, destinationPath: string): Promise<void> {
    assertPublicShareStorageAvailable();
    await copyFile(sourcePath, destinationPath);
}

export async function deletePublicShareAsset(storagePath: string): Promise<void> {
    assertPublicShareStorageAvailable();
    await deleteFile(storagePath);
}

export async function publicShareAssetExists(storagePath: string, expectedSize: number): Promise<boolean> {
    assertPublicShareStorageAvailable();
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
    assertPublicShareStorageAvailable();
    if (isLocalStorage()) {
        const data = readLocalFile(storagePath);
        if (!data) throw new Error('Public share asset not found');
        return { kind: 'buffer', data };
    }
    return { kind: 'stream', data: await s3client.getObject(s3bucket, storagePath) };
}

export async function readPublicShareAssetBytes(storagePath: string, maxBytes: number): Promise<Buffer> {
    assertPublicShareStorageAvailable();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid public share byte limit');
    if (isLocalStorage()) {
        const data = readLocalFile(storagePath);
        if (!data) throw new Error('Public share asset not found');
        if (data.length > maxBytes) throw new Error('Public share asset exceeds byte limit');
        return data;
    }

    const stat = await s3client.statObject(s3bucket, storagePath);
    if (stat.size > maxBytes) throw new Error('Public share asset exceeds byte limit');
    const stream = await s3client.getObject(s3bucket, storagePath);
    const chunks: Buffer[] = [];
    let totalSize = 0;
    try {
        for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalSize += bytes.length;
            if (totalSize > maxBytes) {
                (stream as { destroy?: (error?: Error) => void }).destroy?.();
                throw new Error('Public share asset exceeds byte limit');
            }
            chunks.push(bytes);
        }
    } catch (error) {
        (stream as { destroy?: (error?: Error) => void }).destroy?.();
        throw error;
    }
    return Buffer.concat(chunks, totalSize);
}

export async function deletePublicShareGeneration(shareId: string, generation: string): Promise<void> {
    assertPublicShareStorageAvailable();
    assertSafeIdentifier(shareId);
    assertSafeIdentifier(generation);
    await deleteFilePrefix(`private/session-shares/${shareId}/${generation}`);
}
