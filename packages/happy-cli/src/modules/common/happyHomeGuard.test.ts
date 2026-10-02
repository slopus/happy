/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R11 — the happy home is
 * matched by identity, so another name for it is still the happy home.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { isStrictlyGuardedPath, isWithinDirectory } from './happyHomeGuard';

const roots: string[] = [];
function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'happy-home-guard-')));
    roots.push(root);
    const home = join(root, '.happy');
    mkdirSync(home);
    return { root, home };
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('isWithinDirectory', () => {
    it('matches the directory, anything below it, and nothing beside it', () => {
        const { root, home } = fixture();

        expect(isWithinDirectory(home, home)).toBe(true);
        expect(isWithinDirectory(join(home, 'access.key'), home)).toBe(true);
        expect(isWithinDirectory(join(home, 'not', 'yet', 'there'), home)).toBe(true);
        expect(isWithinDirectory(join(root, 'project', '..', '.happy', 'sessions.json'), home)).toBe(true);
        expect(isWithinDirectory(join(root, '.happy-dev', 'access.key'), home)).toBe(false);
        expect(isWithinDirectory(join(root, 'project', 'file.txt'), home)).toBe(false);
    });

    it.skipIf(process.platform === 'win32')('follows a link that leads into the directory', () => {
        const { root, home } = fixture();
        symlinkSync(home, join(root, 'innocent'));

        expect(isWithinDirectory(join(root, 'innocent', 'access.key'), home)).toBe(true);
        expect(isWithinDirectory(join(root, 'innocent', 'new-file'), home)).toBe(true);
    });

    it('matches another spelling of the directory on a case-insensitive file system', () => {
        const { root, home } = fixture();
        const shouted = join(root, '.HAPPY');
        if (!existsSync(shouted)) return; // case-sensitive: the other spelling is another directory

        expect(isWithinDirectory(join(shouted, 'access.key'), home)).toBe(true);
    });
});

describe('isStrictlyGuardedPath', () => {
    const mode = configuration as { machineControl: 'compat' | 'strict' };
    const previous = mode.machineControl;
    afterEach(() => { mode.machineControl = previous; });

    it('guards the happy home in strict mode only', () => {
        const inside = join(configuration.happyHomeDir, 'access.key');

        mode.machineControl = 'compat';
        expect(isStrictlyGuardedPath(inside)).toBe(false);

        mode.machineControl = 'strict';
        expect(isStrictlyGuardedPath(inside)).toBe(true);
        expect(isStrictlyGuardedPath(configuration.happyHomeDir)).toBe(true);
        expect(isStrictlyGuardedPath(join(tmpdir(), 'elsewhere.txt'))).toBe(false);
    });
});
