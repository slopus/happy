import { Metadata } from '@/sync/storageTypes';

/**
 * Get a relative path from an absolute path using the metadata base path
 */
export function getRelativePath(metadata: Metadata | null | undefined, filePath: string): string {
    if (!metadata) {
        throw new Error("Metadata is " + metadata);
    }
    if (!metadata.path || !filePath.startsWith(metadata.path)) {
        console.log("!!!!!! metadata", metadata);
        console.log("!!!!!! filePath", filePath);
        return filePath;
    }

    const relativePath = filePath.slice(metadata.path.length);
    return relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
}