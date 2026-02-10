import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getProjectPath } from './path';
import { join } from 'node:path';

// Store original env
const originalEnv = { ...process.env };

describe('getProjectPath', () => {
    beforeEach(() => {
        // Reset process.env to a clean state - make a fresh copy each time
        process.env = { ...originalEnv };
        delete process.env.CLAUDE_CONFIG_DIR;
    });

    afterEach(() => {
        // Restore original env
        process.env = { ...originalEnv };
    });

    it('should replace slashes with hyphens in the project path', () => {
        process.env.CLAUDE_CONFIG_DIR = '/test/home/.claude';
        const workingDir = '/Users/steve/projects/my-app';
        const result = getProjectPath(workingDir);
        expect(result).toBe(join('/test/home/.claude', 'projects', '-Users-steve-projects-my-app'));
    });

    it('should replace dots with hyphens in the project path', () => {
        process.env.CLAUDE_CONFIG_DIR = '/test/home/.claude';
        const workingDir = '/Users/steve/projects/app.test.js';
        const result = getProjectPath(workingDir);
        expect(result).toBe(join('/test/home/.claude', 'projects', '-Users-steve-projects-app-test-js'));
    });

    it('should handle paths with both slashes and dots', () => {
        process.env.CLAUDE_CONFIG_DIR = '/test/home/.claude';
        const workingDir = '/var/www/my.site.com/public';
        const result = getProjectPath(workingDir);
        expect(result).toBe(join('/test/home/.claude', 'projects', '-var-www-my-site-com-public'));
    });

    it('should handle relative paths by resolving them first', () => {
        process.env.CLAUDE_CONFIG_DIR = '/test/home/.claude';
        const workingDir = './my-project';
        const result = getProjectPath(workingDir);
        expect(result).toContain(join('/test/home/.claude', 'projects'));
        expect(result).toContain('my-project');
    });

    it('should handle empty directory path', () => {
        process.env.CLAUDE_CONFIG_DIR = '/test/home/.claude';
        const workingDir = '';
        const result = getProjectPath(workingDir);
        expect(result).toContain(join('/test/home/.claude', 'projects'));
    });

    describe('Claude Code path normalization parity', () => {
        // Claude Code replaces ALL non-alphanumeric, non-hyphen characters with hyphens.
        // Happy must match this exactly, otherwise session files won't be found.
        // See: https://github.com/slopus/happy/issues/563

        it('should replace @ symbols with hyphens (Google Drive paths)', () => {
            process.env.CLAUDE_CONFIG_DIR = '/test/home/.claude';
            const workingDir = '/Users/adam/Library/CloudStorage/GoogleDrive-user@gmail.com/projects';
            const result = getProjectPath(workingDir);
            expect(result).toBe(join('/test/home/.claude', 'projects', '-Users-adam-Library-CloudStorage-GoogleDrive-user-gmail-com-projects'));
        });

        it('should replace parentheses with hyphens', () => {
            process.env.CLAUDE_CONFIG_DIR = '/test/home/.claude';
            const workingDir = '/Users/steve/projects/app (copy)';
            const result = getProjectPath(workingDir);
            expect(result).toBe(join('/test/home/.claude', 'projects', '-Users-steve-projects-app--copy-'));
        });

        it('should replace square brackets with hyphens', () => {
            process.env.CLAUDE_CONFIG_DIR = '/test/home/.claude';
            const workingDir = '/Users/steve/projects/[2024] my-project';
            const result = getProjectPath(workingDir);
            expect(result).toBe(join('/test/home/.claude', 'projects', '-Users-steve-projects--2024--my-project'));
        });

        it('should replace tilde with hyphens', () => {
            process.env.CLAUDE_CONFIG_DIR = '/test/home/.claude';
            const workingDir = '/Users/steve/projects/~backup';
            const result = getProjectPath(workingDir);
            expect(result).toBe(join('/test/home/.claude', 'projects', '-Users-steve-projects--backup'));
        });

        it('should replace plus signs with hyphens', () => {
            process.env.CLAUDE_CONFIG_DIR = '/test/home/.claude';
            const workingDir = '/Users/steve/projects/c++';
            const result = getProjectPath(workingDir);
            expect(result).toBe(join('/test/home/.claude', 'projects', '-Users-steve-projects-c--'));
        });

        it('should replace hash symbols with hyphens', () => {
            process.env.CLAUDE_CONFIG_DIR = '/test/home/.claude';
            const workingDir = '/Users/steve/projects/c#-app';
            const result = getProjectPath(workingDir);
            expect(result).toBe(join('/test/home/.claude', 'projects', '-Users-steve-projects-c--app'));
        });

        it('should replace equals and ampersand with hyphens', () => {
            process.env.CLAUDE_CONFIG_DIR = '/test/home/.claude';
            const workingDir = '/Users/steve/projects/key=value&foo';
            const result = getProjectPath(workingDir);
            expect(result).toBe(join('/test/home/.claude', 'projects', '-Users-steve-projects-key-value-foo'));
        });

        it('should replace commas and semicolons with hyphens', () => {
            process.env.CLAUDE_CONFIG_DIR = '/test/home/.claude';
            const workingDir = '/Users/steve/projects/a,b;c';
            const result = getProjectPath(workingDir);
            expect(result).toBe(join('/test/home/.claude', 'projects', '-Users-steve-projects-a-b-c'));
        });

        it('should replace single quotes and exclamation marks with hyphens', () => {
            process.env.CLAUDE_CONFIG_DIR = '/test/home/.claude';
            const workingDir = "/Users/steve/projects/it's-done!";
            const result = getProjectPath(workingDir);
            expect(result).toBe(join('/test/home/.claude', 'projects', '-Users-steve-projects-it-s-done-'));
        });
    });

    describe('CLAUDE_CONFIG_DIR support', () => {
        it('should use default .claude directory when CLAUDE_CONFIG_DIR is not set', () => {
            // When CLAUDE_CONFIG_DIR is not set, it uses homedir()/.claude
            const workingDir = '/Users/steve/projects/my-app';
            const result = getProjectPath(workingDir);
            expect(result).toContain('projects');
            expect(result).toContain('-Users-steve-projects-my-app');
        });

        it('should use CLAUDE_CONFIG_DIR when set', () => {
            process.env.CLAUDE_CONFIG_DIR = '/custom/claude/config';
            const workingDir = '/Users/steve/projects/my-app';
            const result = getProjectPath(workingDir);
            expect(result).toBe(join('/custom/claude/config', 'projects', '-Users-steve-projects-my-app'));
        });

        it('should handle relative CLAUDE_CONFIG_DIR path', () => {
            process.env.CLAUDE_CONFIG_DIR = './config/claude';
            const workingDir = '/Users/steve/projects/my-app';
            const result = getProjectPath(workingDir);
            expect(result).toBe(join('./config/claude', 'projects', '-Users-steve-projects-my-app'));
        });

        it('should fallback to default when CLAUDE_CONFIG_DIR is empty string', () => {
            process.env.CLAUDE_CONFIG_DIR = '';
            const workingDir = '/Users/steve/projects/my-app';
            const result = getProjectPath(workingDir);
            // With empty CLAUDE_CONFIG_DIR, it uses homedir()/.claude
            expect(result).toContain('projects');
            expect(result).toContain('-Users-steve-projects-my-app');
        });

        it('should handle CLAUDE_CONFIG_DIR with trailing slash', () => {
            process.env.CLAUDE_CONFIG_DIR = '/custom/claude/config/';
            const workingDir = '/Users/steve/projects/my-app';
            const result = getProjectPath(workingDir);
            expect(result).toBe(join('/custom/claude/config/', 'projects', '-Users-steve-projects-my-app'));
        });
    });
});
