/** Discover an already-installed executable without changing the host or downloading software. */
import { constants } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export async function motionHarnessExecutable(): Promise<string> {
    if (process.env.PAWS_MOTIONHARNESS_BIN) return process.env.PAWS_MOTIONHARNESS_BIN;
    const candidates = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, process.platform === 'win32' ? 'mh.cmd' : 'mh'));
    if (process.platform === 'darwin') {
        const versions = join(homedir(), '.nvm/versions/node');
        try {
            for (const version of (await readdir(versions)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).slice(0, 100)) {
                candidates.push(join(versions, version, 'lib/node_modules/@motionharness/cli/node_modules', `@motionharness/cli-darwin-${process.arch}`, 'bin/MotionHarness'));
            }
        } catch { /* NVM is optional. */ }
    }
    for (const candidate of candidates) {
        try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try another installed location. */ }
    }
    return 'mh'; // Preserve the normal ENOENT error when no installed tool exists.
}
