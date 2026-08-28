import { describe, expect, it } from 'vitest';
import {
    buildGitDiffCommand,
    buildGitShowBase64Command,
    FULL_FILE_CONTEXT,
    quoteShellPath,
} from './gitDiffCommand';

describe('quoteShellPath', () => {
    it('quotes a plain path', () => {
        expect(quoteShellPath('src/app.ts')).toBe('"src/app.ts"');
    });

    it('survives paths that would otherwise break the command apart', () => {
        expect(quoteShellPath('src/say "hi".ts')).toBe('"src/say \\"hi\\".ts"');
        expect(quoteShellPath('src/back\\slash.ts')).toBe('"src/back\\\\slash.ts"');
        // Unescaped, these would be expanded by the shell rather than read.
        expect(quoteShellPath('src/$HOME.ts')).toBe('"src/\\$HOME.ts"');
        expect(quoteShellPath('src/`whoami`.ts')).toBe('"src/\\`whoami\\`.ts"');
    });
});

describe('buildGitDiffCommand', () => {
    it('asks for git defaults when nothing is requested', () => {
        expect(buildGitDiffCommand('src/app.ts')).toBe(
            'git -c core.quotepath=false diff HEAD --no-ext-diff -- "src/app.ts"',
        );
    });

    it('widens the context when asked', () => {
        expect(buildGitDiffCommand('src/app.ts', { contextLines: 25 })).toContain('-U25');
        expect(buildGitDiffCommand('src/app.ts', { contextLines: FULL_FILE_CONTEXT }))
            .toContain(`-U${FULL_FILE_CONTEXT}`);
    });

    it('keeps a context of zero rather than treating it as unset', () => {
        expect(buildGitDiffCommand('src/app.ts', { contextLines: 0 })).toContain('-U0');
    });

    it('folds whitespace-only changes when asked', () => {
        expect(buildGitDiffCommand('src/app.ts', { ignoreWhitespace: true })).toContain(' -w ');
        expect(buildGitDiffCommand('src/app.ts', { ignoreWhitespace: false })).not.toContain('-w');
    });

    it('combines both without losing either', () => {
        const command = buildGitDiffCommand('src/app.ts', { contextLines: 10, ignoreWhitespace: true });
        expect(command).toContain('-U10');
        expect(command).toContain('-w');
        expect(command.endsWith('-- "src/app.ts"')).toBe(true);
    });
});

describe('buildGitShowBase64Command', () => {
    it('reads the HEAD copy through base64', () => {
        expect(buildGitShowBase64Command('assets/logo.png')).toBe(
            'git -c core.quotepath=false show HEAD:"assets/logo.png" | base64',
        );
    });
});
