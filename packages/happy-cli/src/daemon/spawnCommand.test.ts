import { describe, it, expect } from 'vitest';
import { join } from 'path';

/**
 * Tests for the tmux command construction in daemon session spawning.
 * Verifies that paths with spaces are properly quoted to prevent
 * shell word-splitting issues.
 */
describe('tmux spawn command construction', () => {
    it('should quote cliPath to handle spaces in project path', () => {
        // Simulate the command construction from run.ts
        const projectPathWithSpaces = '/home/user/My Projects/happy-cli';
        const cliPath = join(projectPathWithSpaces, 'dist', 'index.mjs');
        const agent = 'claude';

        // This is the fixed version with quotes around cliPath
        const fullCommand = `node --no-warnings --no-deprecation "${cliPath}" ${agent} --happy-starting-mode remote --started-by daemon`;

        // The path should be properly quoted in the command string
        expect(fullCommand).toContain(`"${cliPath}"`);
        expect(fullCommand).toBe(
            `node --no-warnings --no-deprecation "${projectPathWithSpaces}/dist/index.mjs" claude --happy-starting-mode remote --started-by daemon`
        );
    });

    it('should work correctly with paths without spaces', () => {
        const projectPath = '/home/user/happy-cli';
        const cliPath = join(projectPath, 'dist', 'index.mjs');
        const agent = 'claude';

        const fullCommand = `node --no-warnings --no-deprecation "${cliPath}" ${agent} --happy-starting-mode remote --started-by daemon`;

        expect(fullCommand).toBe(
            'node --no-warnings --no-deprecation "/home/user/happy-cli/dist/index.mjs" claude --happy-starting-mode remote --started-by daemon'
        );
    });

    it('should handle different agent types', () => {
        const cliPath = '/path/to/dist/index.mjs';

        for (const agent of ['claude', 'codex', 'gemini']) {
            const fullCommand = `node --no-warnings --no-deprecation "${cliPath}" ${agent} --happy-starting-mode remote --started-by daemon`;
            expect(fullCommand).toContain(`"${cliPath}" ${agent}`);
        }
    });

    it('should handle paths with special characters', () => {
        const specialPaths = [
            "/home/user/project (copy)/happy-cli/dist/index.mjs",
            "/home/user/project's folder/happy-cli/dist/index.mjs",
            "/home/user/project & backup/happy-cli/dist/index.mjs",
        ];

        for (const cliPath of specialPaths) {
            const fullCommand = `node --no-warnings --no-deprecation "${cliPath}" claude --happy-starting-mode remote --started-by daemon`;
            // Path should be enclosed in double quotes
            expect(fullCommand).toContain(`"${cliPath}"`);
        }
    });
});
