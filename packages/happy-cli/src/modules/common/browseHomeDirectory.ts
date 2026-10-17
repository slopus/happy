/**
 * Canonical directory browsing within home and the machine's mounted volumes.
 * The daemon discovers roots; clients only supply a path. Symlinks are resolved
 * before containment checks, including migrated projects linked from home.
 */
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';

export interface BrowseDirectoryEntry {
    name: string;
    path: string;
    isProjectRoot: boolean;
}

export interface BrowseDirectoryRoot {
    name: string;
    path: string;
    kind: 'home' | 'volume';
}

export interface BrowseDirectoryResponse {
    success: boolean;
    path?: string;
    parent?: string | null;
    home?: string;
    root?: string;
    roots?: BrowseDirectoryRoot[];
    directories?: BrowseDirectoryEntry[];
    error?: string;
}

function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function isContainedPath(root: string, target: string): boolean {
    return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Discover mounted macOS volumes on demand, never unmounted placeholder folders. */
export async function getMountedVolumePaths(
    volumesDirectory: string | undefined = process.platform === 'darwin' ? '/Volumes' : undefined,
): Promise<string[]> {
    if (!volumesDirectory) return [];
    try {
        const parent = await realpath(volumesDirectory);
        const parentStat = await stat(parent);
        const entries = await readdir(parent, { withFileTypes: true });
        const paths = await Promise.all(entries
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
            .map(async (entry) => {
                const path = join(parent, entry.name);
                try {
                    // A mounted filesystem has its own device ID. Reject aliases,
                    // including macOS's system-volume symlink, and stale directories.
                    const canonical = await realpath(path);
                    const info = await stat(canonical);
                    return canonical === path && info.isDirectory() && info.dev !== parentStat.dev ? path : null;
                } catch {
                    return null; // Detached or inaccessible while being enumerated.
                }
            }));
        return paths.filter((path): path is string => path !== null).sort((a, b) => a.localeCompare(b));
    } catch {
        return []; // Home browsing still works without an accessible mount directory.
    }
}

/**
 * Resolve and list a directory inside an authorized root. `volumePaths` must
 * come from the daemon's mount discovery, never from an RPC request or cache.
 */
export async function browseHomeDirectory(
    configuredHome: string,
    requestedPath?: string,
    volumePaths: readonly string[] = [],
): Promise<BrowseDirectoryResponse> {
    let home: string;
    try {
        home = await realpath(resolve(configuredHome));
    } catch (error) {
        return { success: false, error: errorMessage(error, 'Unable to access the home directory') };
    }
    const roots: BrowseDirectoryRoot[] = [{ name: '~', path: home, kind: 'home' }];
    for (const volume of volumePaths) {
        try {
            const path = await realpath(volume);
            if ((await stat(path)).isDirectory() && !roots.some((root) => root.path === path)) {
                roots.push({ name: basename(volume), path, kind: 'volume' });
            }
        } catch {
            // A drive may disappear between discovery and navigation.
        }
    }
    const context = { home, roots };
    const raw = (requestedPath ?? '').trim();
    const lexicalTarget = raw === '' || raw === '~'
        ? home
        : /^~[\\/]/.test(raw) ? resolve(home, raw.slice(2)) : resolve(home, raw);

    let target: string;
    try {
        target = await realpath(lexicalTarget);
    } catch (error) {
        return { ...context, success: false, error: errorMessage(error, 'Unable to access the requested directory') };
    }
    const root = roots.filter((entry) => isContainedPath(entry.path, target))
        .sort((a, b) => b.path.length - a.path.length)[0];
    if (!root) {
        return { ...context, success: false, error: 'Access denied: Path is outside the home directory and mounted volumes' };
    }

    try {
        const entries = await readdir(target, { withFileTypes: true });
        const candidates = await Promise.all(entries
            .filter((entry) => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink()))
            .map(async (entry): Promise<BrowseDirectoryEntry | null> => {
                try {
                    const path = await realpath(join(target, entry.name));
                    if (!roots.some((allowed) => isContainedPath(allowed.path, path)) || !(await stat(path)).isDirectory()) return null;
                    let isProjectRoot = false;
                    try {
                        await stat(join(path, '.git'));
                        isProjectRoot = true;
                    } catch {
                        // No .git entry — just a regular directory.
                    }
                    return { name: entry.name, path, isProjectRoot };
                } catch {
                    return null; // Broken symlink or a directory removed during listing.
                }
            }));
        const directories = candidates.filter((entry): entry is BrowseDirectoryEntry => entry !== null);
        directories.sort((left, right) => left.name.localeCompare(right.name));
        return {
            ...context, success: true, path: target, root: root.path,
            parent: target === root.path ? null : resolve(target, '..'), directories,
        };
    } catch (error) {
        return { ...context, success: false, error: errorMessage(error, 'Unable to list the requested directory') };
    }
}
