import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { validatePath, validateReadPath } from './pathSecurity';
import { homedir } from 'os';
import { join } from 'path';

describe('validatePath', () => {
    const workingDir = resolve('/home/user/project');

    it('should allow paths within working directory', () => {
        expect(validatePath(resolve('/home/user/project/file.txt'), workingDir)).toEqual({
            valid: true,
            resolvedPath: resolve('/home/user/project/file.txt'),
        });
        expect(validatePath('file.txt', workingDir)).toEqual({
            valid: true,
            resolvedPath: resolve('/home/user/project/file.txt'),
        });
        expect(validatePath('./src/file.txt', workingDir)).toEqual({
            valid: true,
            resolvedPath: resolve('/home/user/project/src/file.txt'),
        });
    });

    it('should reject paths outside working directory', () => {
        const result = validatePath(resolve('/etc/passwd'), workingDir);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('outside the working directory');
    });

    it('should prevent path traversal attacks', () => {
        const result = validatePath('../../.ssh/id_rsa', workingDir);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('outside the working directory');
    });

    it('should allow the working directory itself', () => {
        expect(validatePath('.', workingDir)).toEqual({
            valid: true,
            resolvedPath: resolve('/home/user/project'),
        });
        expect(validatePath(workingDir, workingDir)).toEqual({
            valid: true,
            resolvedPath: resolve('/home/user/project'),
        });
    });
});

describe('validateReadPath', () => {
    const home = homedir();
    const cwd = join(home, 'projects', 'demo');

    it('allows an absolute path anywhere inside home', () => {
        expect(validateReadPath(join(home, 'other', 'file.ts'), cwd, home).valid).toBe(true);
    });

    it('allows the containment root itself', () => {
        expect(validateReadPath(home, cwd, home).valid).toBe(true);
    });

    it('resolves relative paths against the working directory', () => {
        const r = validateReadPath('src/index.ts', cwd, home);
        expect(r.valid).toBe(true);
        expect(r.resolvedPath).toBe(join(cwd, 'src/index.ts'));
    });

    it('denies an absolute path outside home', () => {
        expect(validateReadPath('/etc/passwd', cwd, home).valid).toBe(false);
    });

    it('denies traversal that escapes home', () => {
        expect(validateReadPath(join(home, '..', 'someone-else'), cwd, home).valid).toBe(false);
    });

    describe('working directory outside home', () => {
        const externalCwd = resolve('/Volumes/External SSD/Development/demo');

        it('allows the session working directory itself', () => {
            expect(validateReadPath(externalCwd, externalCwd, home)).toEqual({
                valid: true, resolvedPath: externalCwd,
            });
        });

        it('allows absolute and relative files inside the session directory', () => {
            for (const path of ['src/index.ts', join(externalCwd, 'src/index.ts')]) {
                expect(validateReadPath(path, externalCwd, home)).toEqual({
                    valid: true, resolvedPath: join(externalCwd, 'src/index.ts'),
                });
            }
        });

        it('keeps home readable for external sessions', () => {
            expect(validateReadPath(join(home, 'notes.txt'), externalCwd, home).valid).toBe(true);
        });

        it('rejects parent traversal, prefix siblings, and unrelated volumes', () => {
            for (const path of ['..', '../private.txt', `${externalCwd}-private/file.txt`, '/Volumes/Other/file.txt']) {
                expect(validateReadPath(path, externalCwd, home).valid).toBe(false);
            }
        });

        it('keeps writes restricted to the working directory', () => {
            expect(validatePath(join(home, 'notes.txt'), externalCwd).valid).toBe(false);
            expect(validatePath('../private.txt', externalCwd).valid).toBe(false);
            expect(validatePath('notes.txt', externalCwd).valid).toBe(true);
        });
    });
});
