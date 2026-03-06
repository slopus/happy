import { describe, expect, it } from 'vitest';
import {
    formatToolOutputContent,
    isTrimmedToolOutput,
    type ToolOutputContentModel,
} from './toolOutputContent';

function expectText(model: ToolOutputContentModel) {
    expect(model.kind).toBe('text');
    return model as Extract<ToolOutputContentModel, { kind: 'text' }>;
}

function expectCommand(model: ToolOutputContentModel) {
    expect(model.kind).toBe('command');
    return model as Extract<ToolOutputContentModel, { kind: 'command' }>;
}

describe('isTrimmedToolOutput', () => {
    it('detects trimmed output markers', () => {
        expect(isTrimmedToolOutput({
            _outputTrimmed: true,
            _callId: 'call-1',
            _toolResultKind: 'text',
        })).toBe(true);
    });

    it('rejects ordinary tool output payloads', () => {
        expect(isTrimmedToolOutput({ exit_code: 0 })).toBe(false);
        expect(isTrimmedToolOutput(null)).toBe(false);
        expect(isTrimmedToolOutput('plain output')).toBe(false);
    });
});

describe('formatToolOutputContent', () => {
    it('renders Read output from file.content as text', () => {
        const model = formatToolOutputContent({
            toolName: 'Read',
            toolInput: { file_path: '/tmp/demo.ts' },
            result: {
                file: {
                    content: 'export const demo = 1;\n',
                },
            },
            kind: 'text',
        });

        expect(expectText(model).text).toBe('export const demo = 1;\n');
    });

    it('renders Grep output from content as text', () => {
        const model = formatToolOutputContent({
            toolName: 'Grep',
            toolInput: { pattern: 'demo' },
            result: {
                content: 'src/demo.ts:1:export const demo = 1;',
                numFiles: 1,
            },
            kind: 'text',
        });

        expect(expectText(model).text).toContain('src/demo.ts:1:export const demo = 1;');
    });

    it('renders Glob output from filenames arrays as text', () => {
        const model = formatToolOutputContent({
            toolName: 'Glob',
            toolInput: { pattern: '**/*.ts' },
            result: {
                filenames: ['src/a.ts', 'src/b.ts'],
            },
            kind: 'text',
        });

        expect(expectText(model).text).toBe('src/a.ts\nsrc/b.ts');
    });

    it('renders CodexBash output as a command model', () => {
        const model = formatToolOutputContent({
            toolName: 'CodexBash',
            toolInput: {
                command: ['/bin/bash', '-lc', 'sed -n "1,20p" src/demo.ts'],
            },
            result: {
                stdout: 'demo\n',
                stderr: '',
                exit_code: 0,
            },
            kind: 'command',
        });

        const command = expectCommand(model);
        expect(command.command).toBe('sed -n "1,20p" src/demo.ts');
        expect(command.stdout).toBe('demo\n');
        expect(command.stderr).toBeNull();
        expect(command.error).toBeNull();
    });

    it('prefers parsed_cmd when formatting CodexBash commands', () => {
        const model = formatToolOutputContent({
            toolName: 'CodexBash',
            toolInput: {
                command: ['/bin/bash', '-lc', 'cat ignored'],
                parsed_cmd: [{ type: 'read', cmd: 'sed -n "1,40p" src/demo.ts' }],
            },
            result: {
                stdout: 'demo\n',
                stderr: '',
                exit_code: 0,
            },
            kind: 'command',
        });

        expect(expectCommand(model).command).toBe('sed -n "1,40p" src/demo.ts');
    });

    it('renders GeminiBash output as a command model', () => {
        const model = formatToolOutputContent({
            toolName: 'GeminiBash',
            toolInput: {
                command: ['bash', '-lc', 'ls src'],
            },
            result: {
                stdout: 'a.ts\n',
                stderr: 'warning\n',
                exit_code: 0,
            },
            kind: 'command',
        });

        const command = expectCommand(model);
        expect(command.command).toBe('ls src');
        expect(command.stdout).toBe('a.ts\n');
        expect(command.stderr).toBe('warning\n');
    });

    it('falls back to structured data for WebSearch results', () => {
        const model = formatToolOutputContent({
            toolName: 'WebSearch',
            toolInput: { query: 'happy app' },
            result: {
                query: 'happy app',
                results: [{ title: 'Happy', url: 'https://example.com' }],
            },
            kind: 'structured',
        });

        expect(model).toEqual({
            kind: 'structured',
            data: {
                query: 'happy app',
                results: [{ title: 'Happy', url: 'https://example.com' }],
            },
        });
    });
});
