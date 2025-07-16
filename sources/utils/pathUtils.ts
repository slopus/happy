import { Metadata } from '@/sync/storageTypes';

/**
 * Resolves a path relative to the root path from metadata.
 * ALL paths are treated as relative to the metadata root, regardless of their format.
 * If metadata is not provided, returns the original path.
 * 
 * @param path - The path to resolve (always treated as relative to the metadata root)
 * @param metadata - Optional metadata containing the root path
 * @returns The resolved absolute path
 */
export function resolvePath(path: string, metadata: Metadata | null): string {
    if (!metadata) {
        return path;
    }
    if (path.toLowerCase().startsWith(metadata.path.toLowerCase())) {
        let out = path.slice(metadata.path.length);
        if (out.startsWith('/')) {
            out = out.slice(1);
        }
        return out;
    }
    return path;
}