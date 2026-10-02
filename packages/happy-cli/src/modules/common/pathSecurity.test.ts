import { afterEach, describe, it, expect } from 'vitest';
import { dirname, join, resolve } from 'path';
import { configuration } from '@/configuration';
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
});

/*
 * aplus-dev-studio specs/e2ee-machine-control-boundary R11 — in strict mode
 * every handler that checks paths here keeps out of the happy home.
 */
describe('validatePath under strict machine control', () => {
    const mode = configuration as { machineControl: 'compat' | 'strict' };
    const previous = mode.machineControl;
    const workingDirectory = dirname(configuration.happyHomeDir);
    afterEach(() => { mode.machineControl = previous; });

    it('refuses the happy home and anything in it', () => {
        mode.machineControl = 'strict';

        for (const path of [configuration.happyHomeDir, join(configuration.happyHomeDir, 'sessions.json')]) {
            const result = validatePath(path, workingDirectory);
            expect(result.valid).toBe(false);
            expect(result.error).toContain('happy home');
        }
        expect(validatePath(join(workingDirectory, 'project', 'file.txt'), workingDirectory).valid).toBe(true);
    });

    it('leaves the happy home to the working directory check in compat', () => {
        mode.machineControl = 'compat';

        expect(validatePath(join(configuration.happyHomeDir, 'sessions.json'), workingDirectory).valid).toBe(true);
    });
});
