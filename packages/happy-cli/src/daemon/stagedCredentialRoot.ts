/** Mandatory sessions stage beneath the passwd home, never caller-controlled TMPDIR. */
import { lstatSync, mkdirSync } from 'node:fs';
import { userInfo, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSessionSandboxPolicyMode, MandatorySandboxError } from '@/sandbox/sandboxPolicy';

export function privateStagingRoot(home: string = userInfo().homedir): string {
    const root = join(home, '.happy-staging');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new MandatorySandboxError('init-failed', 'insecure credential staging root');
    return root;
}
export function stagingParent(): string {
    return resolveSessionSandboxPolicyMode() === 'mandatory' ? privateStagingRoot() : tmpdir();
}
