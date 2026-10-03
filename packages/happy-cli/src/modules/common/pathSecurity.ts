import { resolve, sep } from 'path';
import { isStrictlyGuardedPath } from './happyHomeGuard';

export interface PathValidationResult {
    valid: boolean;
    resolvedPath?: string;
    error?: string;
}

/**
 * Validates that a path is within the allowed working directory
 * @param targetPath - The path to validate (can be relative or absolute)
 * @param workingDirectory - The session's working directory (must be absolute)
 * @returns Validation result
 */
export function validatePath(targetPath: string, workingDirectory: string): PathValidationResult {
    // Resolve both paths to absolute paths to handle path traversal attempts
    const resolvedTarget = resolve(workingDirectory, targetPath);
    const resolvedWorkingDir = resolve(workingDirectory);

    // Check if the resolved target path starts with the working directory
    // Uses path.sep to work correctly on both Windows (\) and Unix (/)
    if (!resolvedTarget.startsWith(resolvedWorkingDir + sep) && resolvedTarget !== resolvedWorkingDir) {
        return {
            valid: false,
            resolvedPath: resolvedTarget,
            error: `Access denied: Path '${targetPath}' is outside the working directory`
        };
    }

    // aplus-dev-studio specs/e2ee-machine-control-boundary R11.
    if (isStrictlyGuardedPath(resolvedTarget)) {
        return {
            valid: false,
            resolvedPath: resolvedTarget,
            error: `Access denied: Path '${targetPath}' is in the happy home directory, which strict machine control keeps out of reach`
        };
    }

    return { valid: true, resolvedPath: resolvedTarget };
}
