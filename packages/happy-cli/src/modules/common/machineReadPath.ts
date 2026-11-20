import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { getMountedVolumePaths } from './browseHomeDirectory';
import type { PathValidationResult } from './pathSecurity';

/** Read-only roots are discovered on the execution machine, never supplied by the RPC caller. */
export async function validateMachineReadPath(
    targetPath: string,
    workingDirectory: string,
    home: string,
    mountedVolumes?: readonly string[],
): Promise<PathValidationResult> {
    try {
        const volumes = mountedVolumes ?? await getMountedVolumePaths();
        const roots = (await Promise.all([home, workingDirectory, ...volumes].map(async root => {
            try { return await realpath(resolve(root)); } catch { return null; }
        }))).filter((root): root is string => root !== null);
        const target = await realpath(resolve(workingDirectory, targetPath));
        if (!roots.some(root => target === root || target.startsWith(root.endsWith(sep) ? root : root + sep))) {
            return { valid: false, resolvedPath: target, error: `Access denied: Path '${targetPath}' is outside the allowed root` };
        }
        return { valid: true, resolvedPath: target };
    } catch (error) {
        return { valid: false, error: error instanceof Error ? error.message : 'Unable to resolve read path' };
    }
}
