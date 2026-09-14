import { describe, it, expect } from 'vitest';
import os from 'os';
import { resolve } from 'path';
import { validatePath } from './pathSecurity';

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

    describe('machine-level RPC sandbox (homedir as workingDirectory)', () => {
        // Regression guard for new-session directory autocomplete:
        // machine-level RPC must sandbox to os.homedir(), not the daemon's
        // process.cwd(). Otherwise listing any folder above the daemon's
        // launch directory (the common case — daemon is started from a
        // project subdir) gets rejected as "outside the working directory".
        const homeDir = os.homedir();

        it('allows listing the homedir itself', () => {
            expect(validatePath(homeDir, homeDir).valid).toBe(true);
        });

        it('allows listing arbitrary subdirectories under homedir', () => {
            // Any folder under home should be reachable — this is what the
            // autocomplete needs while the user types `~/proj…`.
            expect(validatePath(resolve(homeDir, 'some-project'), homeDir).valid).toBe(true);
            expect(validatePath(resolve(homeDir, 'a/b/c'), homeDir).valid).toBe(true);
        });

        it('still blocks paths outside homedir (no escape via ..)', () => {
            // Sandbox boundary still holds — homedir is broader than a
            // project dir, not unbounded.
            expect(validatePath('/etc/passwd', homeDir).valid).toBe(false);
            expect(validatePath(resolve(homeDir, '../../etc/passwd'), homeDir).valid).toBe(false);
        });

        it('demonstrates the regression: a deeper cwd would reject sibling dirs', () => {
            // If machine-level RPC used process.cwd() (e.g. a project subdir
            // like `~/happy/packages/happy-cli`), the user could not autocomplete
            // any other folder. This test pins that contrast in place.
            const projectSubdir = resolve(homeDir, 'happy/packages/happy-cli');
            expect(validatePath(resolve(homeDir, 'some-other-project'), projectSubdir).valid).toBe(false);
            // …whereas with homedir as workingDirectory, the same target is allowed:
            expect(validatePath(resolve(homeDir, 'some-other-project'), homeDir).valid).toBe(true);
        });
    });
});
