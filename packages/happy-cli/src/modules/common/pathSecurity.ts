import { resolve } from 'path';
import { realpathSync, lstatSync } from 'fs';

export interface PathValidationResult {
    valid: boolean;
    error?: string;
}

/**
 * Validates that a path is within any of the allowed directories.
 * Resolves symlinks to prevent traversal via symbolic links.
 * @param targetPath - The path to validate (can be relative or absolute)
 * @param workingDirectory - The session's working directory (must be absolute)
 * @param additionalAllowedDirs - Extra absolute directories that are also permitted
 * @returns Validation result
 */
export function validatePath(targetPath: string, workingDirectory: string, additionalAllowedDirs?: string[]): PathValidationResult {
    const resolvedTarget = resolve(workingDirectory, targetPath);

    // Resolve symlinks to get the true filesystem path.
    // This prevents symlink-based traversal (e.g., ln -s /etc/passwd /tmp/happy/uploads/evil.jpg)
    let realTarget: string;
    try {
        realTarget = realpathSync(resolvedTarget);
    } catch {
        // File doesn't exist yet (e.g., new file being written) — validate the parent dir instead
        const parentDir = resolve(resolvedTarget, '..');
        try {
            realTarget = realpathSync(parentDir) + '/' + resolvedTarget.split('/').pop();
        } catch {
            // Parent doesn't exist either — fall back to the resolved path (mkdir -p will create it)
            realTarget = resolvedTarget;
        }
    }

    // Collect all directories the path is allowed to live under.
    // Resolve symlinks on allowed dirs so comparisons are consistent with the symlink-resolved realTarget.
    const allowedDirs = [workingDirectory, ...(additionalAllowedDirs ?? [])].map(d => {
        const resolved = resolve(d);
        try {
            return realpathSync(resolved);
        } catch {
            // Directory may not exist yet (e.g., upload dir before first upload) — fall back to resolve()
            return resolved;
        }
    });

    for (const dir of allowedDirs) {
        if (realTarget.startsWith(dir + '/') || realTarget === dir) {
            return { valid: true };
        }
    }

    return {
        valid: false,
        error: `Access denied: Path '${targetPath}' is outside the allowed directories`
    };
}
