/**
 * Canonical, home-scoped directory browsing for machine RPC handlers.
 * Resolves symlinks before enforcing containment and returns stable paths plus
 * filesystem errors for the app's remote working-directory picker.
 */
import { readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

export interface BrowseDirectoryEntry {
    name: string;
    path: string;
    isProjectRoot: boolean;
}

export interface BrowseDirectoryResponse {
    success: boolean;
    path?: string;
    parent?: string | null;
    home?: string;
    directories?: BrowseDirectoryEntry[];
    error?: string;
}

function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message.trim().length > 0
        ? error.message
        : fallback;
}

function isContainedPath(root: string, target: string): boolean {
    return target === root || target.startsWith(`${root}${sep}`);
}

/**
 * Resolve and list a directory below the canonical home root.
 *
 * `path.resolve` alone is not a security boundary because an in-home symlink
 * can point outside home. Both sides are canonicalized with `realpath` before
 * containment is checked, and the canonical paths are returned to callers so
 * subsequent navigation stays on the same boundary.
 */
export async function browseHomeDirectory(
    configuredHome: string,
    requestedPath?: string,
): Promise<BrowseDirectoryResponse> {
    let home: string;
    try {
        home = await realpath(resolve(configuredHome));
    } catch (error) {
        return {
            success: false,
            error: errorMessage(error, 'Unable to access the home directory'),
        };
    }

    const raw = (requestedPath ?? '').trim();
    const lexicalTarget = raw === '' || raw === '~'
        ? home
        : /^~[\\/]/.test(raw)
            ? resolve(home, raw.slice(2))
            : resolve(home, raw);

    let target: string;
    try {
        target = await realpath(lexicalTarget);
    } catch (error) {
        return {
            success: false,
            error: errorMessage(error, 'Unable to access the requested directory'),
        };
    }

    if (!isContainedPath(home, target)) {
        return {
            success: false,
            error: 'Access denied: Path is outside the home directory',
        };
    }

    try {
        const entries = await readdir(target, { withFileTypes: true });
        const directories: BrowseDirectoryEntry[] = await Promise.all(
            entries
                .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
                .map(async (entry) => {
                    const fullPath = join(target, entry.name);
                    let isProjectRoot = false;
                    try {
                        await stat(join(fullPath, '.git'));
                        isProjectRoot = true;
                    } catch {
                        // No .git entry — just a regular directory.
                    }
                    return { name: entry.name, path: fullPath, isProjectRoot };
                }),
        );
        directories.sort((left, right) => left.name.localeCompare(right.name));

        return {
            success: true,
            path: target,
            parent: target === home ? null : resolve(target, '..'),
            home,
            directories,
        };
    } catch (error) {
        return {
            success: false,
            error: errorMessage(error, 'Unable to list the requested directory'),
        };
    }
}
