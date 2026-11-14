import { describe, expect, it } from 'vitest';
import { selectToolFailure, summarizeToolFailureOutput, toolFailureDetail } from './toolFailure';

describe('command failure summaries', () => {
    it('ignores a documented error example and selects the real terminal diagnostic', () => {
        expect(summarizeToolFailureOutput([
            '---', 'name: dev', '---',
            '```sh', 'sed: /example/SKILL.md: Permission denied', '```',
            'cat: /actual/SKILL.md: No such file or directory',
        ].join('\n'))).toBe('cat: /actual/SKILL.md: No such file or directory');
    });

    it('does not report fenced error examples as a command failure', () => {
        expect(summarizeToolFailureOutput('---\nname: dev\n---\n```\nError: example\n```')).toBeNull();
    });

    it('removes ANSI color controls and supports CRLF diagnostics', () => {
        expect(summarizeToolFailureOutput('---\r\nname: dev\r\n\x1b[31mcat: /skills/dev/SKILL.md: Permission denied\x1b[0m'))
            .toBe('cat: /skills/dev/SKILL.md: Permission denied');
    });

    it('keeps plain error messages and bounds the summary', () => {
        expect(summarizeToolFailureOutput('\nCannot read SKILL.md\nPermission denied')).toBe('Cannot read SKILL.md');
        expect(summarizeToolFailureOutput('Error: ' + 'x'.repeat(500))?.length).toBe(280);
    });

    it.each(['', '  ', '---\nname: dev', '# Skill instructions\nError handling guide'])('does not use document metadata as an error: %s', (output) => {
        expect(summarizeToolFailureOutput(output)).toBeNull();
    });
});

describe('bounded command failure details', () => {
    it.each([3980, 8000])('retains a complete diagnostic at offset %s', (offset) => {
        const diagnostic = 'sed: /skills/workflow/SKILL.md: No such file or directory';
        const output = 'x'.repeat(offset) + '\n' + diagnostic + '\n' + 'y'.repeat(5000);
        const detail = toolFailureDetail(output, diagnostic);
        expect(detail).toContain(diagnostic);
        expect(detail.length).toBeLessThanOrEqual(4000);
    });

    it('keeps short output unchanged', () => {
        expect(toolFailureDetail('Error: failed', 'Error: failed')).toBe('Error: failed');
    });
});


describe('real runtime diagnostics after document output', () => {
    it.each([
        'ls: /skills/release-ops/scripts: No such file or directory',
        'rg: /missing: No such file or directory (os error 2)',
        'find: /missing: Permission denied',
        'curl: (22) The requested URL returned error: 404',
        'node:internal/modules/cjs/loader:1404',
        "FileNotFoundError: [Errno 2] No such file or directory: '/missing'",
    ])('retains %s', (diagnostic) => {
        const output = '---\nname: release-ops\n---\n' + 'instructions\n'.repeat(600) + diagnostic;
        expect(summarizeToolFailureOutput(output)).toBe(diagnostic);
        expect(toolFailureDetail(output, 'Command exited with code 1.')).toContain(diagnostic);
    });
});


describe('failure candidate selection', () => {
    it.each(['stderr', 'output', 'aggregatedOutput', 'aggregated_output', 'result', 'content'])('finds diagnostics in nested %s after generic metadata', field => {
        expect(selectToolFailure([
            { message: 'Command exited with code 1.', [field]: 'curl: (6) Could not resolve host: invalid.test' },
        ], 'The tool reported a failure.').summary).toBe('curl: (6) Could not resolve host: invalid.test');
    });
    it('keeps a real plain message over an exit-code-only error', () => {
        expect(selectToolFailure(['Command exited with code 1.', 'Access denied by the service'], 'fallback').summary)
            .toBe('Access denied by the service');
    });
});
