import { afterEach, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, lstatSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateStagingRoot } from './stagedCredentialRoot';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
it('uses a fixed private root and rejects permissions changes or symlink replacements', () => {
    const home = mkdtempSync(join(tmpdir(), 'staging-test-')); roots.push(home);
    const root = privateStagingRoot(home);
    expect(root).toBe(join(home, '.happy-staging'));
    expect(lstatSync(root).mode & 0o777).toBe(0o700);
    chmodSync(root, 0o755);
    expect(() => privateStagingRoot(home)).toThrow();
    rmSync(root, { recursive: true });
    mkdirSync(join(home, 'other')); symlinkSync(join(home, 'other'), root);
    expect(() => privateStagingRoot(home)).toThrow();
});
