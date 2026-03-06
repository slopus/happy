import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trimToolUseResult, trimToolResultContent, trimToolUseInput } from './trimToolUseResult';

// Mock diffStore to avoid file I/O
vi.mock('../modules/common/diffStore', () => ({
    saveDiffRecords: vi.fn(),
}));
import { saveDiffRecords } from '../modules/common/diffStore';

vi.mock('../modules/common/toolOutputStore', () => ({
    saveToolOutputRecord: vi.fn(),
}));
import { saveToolOutputRecord } from '../modules/common/toolOutputStore';

describe('trimToolUseResult', () => {
    const mockSaveToolOutput = saveToolOutputRecord as ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockSaveToolOutput.mockClear();
    });

    it('returns null/undefined unchanged', () => {
        expect(trimToolUseResult('Read', null)).toBeNull();
        expect(trimToolUseResult('Read', undefined)).toBeUndefined();
    });

    describe('Edit/MultiEdit/Write — removes originalFile', () => {
        const editResult = {
            filePath: '/src/app.ts',
            oldString: 'const a = 1',
            newString: 'const a = 2',
            originalFile: 'x'.repeat(100_000),
            structuredPatch: [{ oldStart: 1, newStart: 1 }],
            userModified: false,
            replaceAll: false,
        };

        for (const tool of ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']) {
            it(`${tool}: removes originalFile, keeps other fields`, () => {
                const trimmed = trimToolUseResult(tool, editResult) as any;
                expect(trimmed.originalFile).toBeUndefined();
                expect(trimmed.filePath).toBe('/src/app.ts');
                expect(trimmed.oldString).toBe('const a = 1');
                expect(trimmed.newString).toBe('const a = 2');
                expect(trimmed.structuredPatch).toEqual([{ oldStart: 1, newStart: 1 }]);
            });
        }
    });

    describe('Read — strips file content, keeps metadata', () => {
        it('object with file.content', () => {
            const result = {
                type: 'text',
                file: {
                    filePath: '/src/app.ts',
                    content: 'x'.repeat(50_000),
                    numLines: 200,
                    startLine: 1,
                    totalLines: 200,
                },
            };
            const trimmed = trimToolUseResult('Read', result) as any;
            expect(trimmed.type).toBe('text');
            expect(trimmed.file.filePath).toBe('/src/app.ts');
            expect(trimmed.file.numLines).toBe(200);
            expect(trimmed.file.totalLines).toBe(200);
            expect(trimmed.file.content).toBeUndefined();
        });

        it('stores full result and tags trimmed output when session metadata is provided', () => {
            const result = {
                type: 'text',
                file: {
                    filePath: '/src/app.ts',
                    content: 'x'.repeat(50_000),
                    numLines: 200,
                    startLine: 1,
                    totalLines: 200,
                },
            };
            const trimmed = trimToolUseResult('Read', result, 'session-1', 'call-read') as any;

            expect(trimmed).toEqual({
                type: 'text',
                file: {
                    filePath: '/src/app.ts',
                    numLines: 200,
                    startLine: 1,
                    totalLines: 200,
                },
                _outputTrimmed: true,
                _callId: 'call-read',
                _toolResultKind: 'text',
            });
            expect(mockSaveToolOutput).toHaveBeenCalledOnce();
        });

        it('object without file field', () => {
            const result = { type: 'image' };
            const trimmed = trimToolUseResult('Read', result) as any;
            expect(trimmed).toEqual({ type: 'image' });
        });
    });

    describe('Grep — removes content, keeps metadata', () => {
        it('removes match content', () => {
            const result = {
                content: 'line1\nline2\nline3',
                filenames: ['a.ts', 'b.ts'],
                numFiles: 2,
                numLines: 3,
                mode: 'content',
            };
            const trimmed = trimToolUseResult('Grep', result) as any;
            expect(trimmed.content).toBeUndefined();
            expect(trimmed.filenames).toEqual(['a.ts', 'b.ts']);
            expect(trimmed.numFiles).toBe(2);
            expect(trimmed.numLines).toBe(3);
        });

        it('stores full result and tags trimmed output when session metadata is provided', () => {
            const result = {
                content: 'line1\nline2\nline3',
                filenames: ['a.ts', 'b.ts'],
                numFiles: 2,
                numLines: 3,
                mode: 'content',
            };
            const trimmed = trimToolUseResult('Grep', result, 'session-1', 'call-grep') as any;

            expect(trimmed).toEqual({
                filenames: ['a.ts', 'b.ts'],
                numFiles: 2,
                numLines: 3,
                mode: 'content',
                _outputTrimmed: true,
                _callId: 'call-grep',
                _toolResultKind: 'text',
            });
            expect(mockSaveToolOutput).toHaveBeenCalledOnce();
        });
    });

    describe('Glob — removes filenames, keeps numFiles', () => {
        it('computes numFiles from filenames array', () => {
            const result = {
                filenames: ['a.ts', 'b.ts', 'c.ts'],
                truncated: false,
                durationMs: 12,
            };
            const trimmed = trimToolUseResult('Glob', result) as any;
            expect(trimmed.filenames).toBeUndefined();
            expect(trimmed.numFiles).toBe(3);
            expect(trimmed.truncated).toBe(false);
        });
    });

    describe('LS — fully trimmed (string and object)', () => {
        it('trims string toolUseResult', () => {
            const listing = '/src\n  app.ts\n  index.ts\n';
            expect(trimToolUseResult('LS', listing)).toEqual({});
        });

        it('trims object toolUseResult', () => {
            expect(trimToolUseResult('LS', { files: ['a', 'b'] })).toEqual({});
        });

        it('stores full result and returns a loadable marker when session metadata is provided', () => {
            const trimmed = trimToolUseResult('LS', '/src\n  app.ts\n', 'session-1', 'call-ls');

            expect(trimmed).toEqual({
                _outputTrimmed: true,
                _callId: 'call-ls',
                _toolResultKind: 'text',
            });
            expect(mockSaveToolOutput).toHaveBeenCalledOnce();
        });
    });

    describe('Task — removes content and prompt', () => {
        it('keeps metadata', () => {
            const result = {
                content: 'x'.repeat(50_000),
                prompt: 'Do something',
                status: 'completed',
                usage: { input: 100, output: 200 },
                agentId: 'abc123',
                totalDurationMs: 5000,
            };
            const trimmed = trimToolUseResult('Task', result) as any;
            expect(trimmed.content).toBeUndefined();
            expect(trimmed.prompt).toBeUndefined();
            expect(trimmed.status).toBe('completed');
            expect(trimmed.usage).toEqual({ input: 100, output: 200 });
            expect(trimmed.agentId).toBe('abc123');
        });
    });

    describe('Fully trimmable tools (string and object)', () => {
        for (const tool of ['WebFetch', 'ToolSearch', 'Skill', 'EnterPlanMode', 'enter_plan_mode']) {
            it(`${tool}: trims string to {}`, () => {
                expect(trimToolUseResult(tool, 'some long string result')).toEqual({});
            });
            it(`${tool}: trims object to {}`, () => {
                expect(trimToolUseResult(tool, { data: 'x' })).toEqual({});
            });
        }
    });

    describe('WebSearch — keeps query only', () => {
        it('trims object', () => {
            const result = { query: 'test', results: [{ url: 'x' }] };
            expect(trimToolUseResult('WebSearch', result)).toEqual({ query: 'test' });
        });

        it('stores full result and tags trimmed output when session metadata is provided', () => {
            const result = { query: 'test', results: [{ url: 'x' }] };
            const trimmed = trimToolUseResult('WebSearch', result, 'session-1', 'call-web-search');

            expect(trimmed).toEqual({
                query: 'test',
                _outputTrimmed: true,
                _callId: 'call-web-search',
                _toolResultKind: 'structured',
            });
            expect(mockSaveToolOutput).toHaveBeenCalledOnce();
        });
    });

    describe('Bash/TodoWrite — kept as-is', () => {
        it('Bash object unchanged', () => {
            const result = { stdout: 'hello', stderr: '', interrupted: false };
            expect(trimToolUseResult('Bash', result)).toBe(result);
        });

        it('Bash string unchanged', () => {
            expect(trimToolUseResult('Bash', 'error output')).toBe('error output');
        });

        it('TodoWrite unchanged', () => {
            const result = { newTodos: [{ content: 'a', status: 'pending' }] };
            expect(trimToolUseResult('TodoWrite', result)).toBe(result);
        });
    });

    describe('Unknown/MCP tools — kept as-is', () => {
        it('passes through unknown tool', () => {
            const result = { data: 'some mcp result' };
            expect(trimToolUseResult('mcp__slack__send', result)).toBe(result);
        });

        it('does not store output for excluded tools', () => {
            const result = { stdout: 'hello', stderr: '' };
            const trimmed = trimToolUseResult('Bash', result, 'session-1', 'call-bash');

            expect(trimmed).toBe(result);
            expect(mockSaveToolOutput).not.toHaveBeenCalled();
        });
    });
});

describe('trimToolResultContent', () => {
    it('passes through non-trimmable tools', () => {
        const long = 'x'.repeat(1000);
        expect(trimToolResultContent('Bash', long)).toBe(long);
        expect(trimToolResultContent('Edit', long)).toBe(long);
        expect(trimToolResultContent('TodoWrite', long)).toBe(long);
    });

    it('trims long string for trimmable tools', () => {
        const long = 'x'.repeat(1000);
        expect(trimToolResultContent('Read', long)).toBe('[trimmed]');
        expect(trimToolResultContent('Grep', long)).toBe('[trimmed]');
        expect(trimToolResultContent('Glob', long)).toBe('[trimmed]');
        expect(trimToolResultContent('LS', long)).toBe('[trimmed]');
        expect(trimToolResultContent('Task', long)).toBe('[trimmed]');
    });

    it('keeps short string even for trimmable tools', () => {
        expect(trimToolResultContent('Read', 'short')).toBe('short');
    });

    it('trims array content with large total text', () => {
        const arr = [
            { type: 'text', text: 'x'.repeat(300) },
            { type: 'text', text: 'y'.repeat(300) },
        ];
        expect(trimToolResultContent('Read', arr)).toBe('[trimmed]');
    });

    it('keeps array content with small total text', () => {
        const arr = [{ type: 'text', text: 'hello' }];
        expect(trimToolResultContent('Read', arr)).toBe(arr);
    });

    it('keeps non-string/non-array content', () => {
        expect(trimToolResultContent('Read', 42)).toBe(42);
        expect(trimToolResultContent('Read', { foo: 'bar' })).toEqual({ foo: 'bar' });
    });
});

describe('trimToolUseInput', () => {
    const mockSave = saveDiffRecords as ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockSave.mockClear();
    });

    describe('Edit', () => {
        it('trims input and saves to diffStore', () => {
            const block = {
                type: 'tool_use',
                id: 'call-123',
                name: 'Edit',
                input: {
                    file_path: '/src/app.ts',
                    old_string: 'const a = 1',
                    new_string: 'const a = 2',
                    replace_all: false,
                },
            };
            const result = trimToolUseInput(block, 'session-1');
            expect(result.input).toEqual({
                file_path: '/src/app.ts',
                _trimmed: true,
                callId: 'call-123',
                additions: 1,
                deletions: 1,
            });
            expect(result.input.old_string).toBeUndefined();
            expect(result.input.new_string).toBeUndefined();
            expect(mockSave).toHaveBeenCalledOnce();
            const records = mockSave.mock.calls[0][1];
            expect(records).toHaveLength(1);
            expect(records[0].callId).toBe('call-123');
            expect(records[0].agent).toBe('claude');
            expect(records[0].filePath).toBe('/src/app.ts');
            expect(JSON.parse(records[0].diff)).toEqual({
                oldString: 'const a = 1',
                newString: 'const a = 2',
            });
        });

        it('computes accurate additions/deletions via LCS diff', () => {
            const block = {
                type: 'tool_use',
                id: 'call-lcs',
                name: 'Edit',
                input: {
                    file_path: '/src/app.ts',
                    // 3 lines, only middle line changed
                    old_string: 'a\nb\nc',
                    new_string: 'a\nx\nc',
                },
            };
            const result = trimToolUseInput(block, 'session-lcs');
            // LCS = 2 (a, c unchanged), so additions=1, deletions=1
            expect(result.input.additions).toBe(1);
            expect(result.input.deletions).toBe(1);
        });

        it('handles trailing newline without off-by-one', () => {
            const block = {
                type: 'tool_use',
                id: 'call-trail',
                name: 'Edit',
                input: {
                    file_path: '/src/app.ts',
                    old_string: 'a\nb\n',
                    new_string: 'a\nx\n',
                },
            };
            const result = trimToolUseInput(block, 'session-trail');
            expect(result.input.additions).toBe(1);
            expect(result.input.deletions).toBe(1);
        });

        it('returns block unchanged if no file_path', () => {
            const block = {
                type: 'tool_use',
                id: 'call-123',
                name: 'Edit',
                input: { old_string: 'x', new_string: 'y' },
            };
            expect(trimToolUseInput(block, 'session-1')).toBe(block);
            expect(mockSave).not.toHaveBeenCalled();
        });
    });

    describe('Write', () => {
        it('trims input and saves content as newString', () => {
            const block = {
                type: 'tool_use',
                id: 'call-456',
                name: 'Write',
                input: {
                    file_path: '/src/new.ts',
                    content: 'export const x = 1;',
                },
            };
            const result = trimToolUseInput(block, 'session-2');
            expect(result.input).toEqual({
                file_path: '/src/new.ts',
                _trimmed: true,
                callId: 'call-456',
                additions: 1,
                deletions: 0,
            });
            expect(result.input.content).toBeUndefined();
            const records = mockSave.mock.calls[0][1];
            expect(JSON.parse(records[0].diff)).toEqual({
                oldString: '',
                newString: 'export const x = 1;',
            });
        });

        it('handles trailing newline without off-by-one', () => {
            const block = {
                type: 'tool_use',
                id: 'call-write-trail',
                name: 'Write',
                input: {
                    file_path: '/src/new.ts',
                    content: 'line1\nline2\n',
                },
            };
            const result = trimToolUseInput(block, 'session-write-trail');
            // "line1\nline2\n" → strip trailing \n → "line1\nline2" → 2 lines
            expect(result.input.additions).toBe(2);
            expect(result.input.deletions).toBe(0);
        });
    });

    describe('MultiEdit', () => {
        it('trims input and saves each edit as separate record', () => {
            const block = {
                type: 'tool_use',
                id: 'call-789',
                name: 'MultiEdit',
                input: {
                    file_path: '/src/app.ts',
                    edits: [
                        { old_string: 'a', new_string: 'b' },
                        { old_string: 'c', new_string: 'd' },
                    ],
                },
            };
            const result = trimToolUseInput(block, 'session-3');
            expect(result.input).toEqual({
                file_path: '/src/app.ts',
                _trimmed: true,
                callId: 'call-789',
                editCount: 2,
                additions: 2,
                deletions: 2,
            });
            expect(result.input.edits).toBeUndefined();
            const records = mockSave.mock.calls[0][1];
            expect(records).toHaveLength(2);
            expect(records[0].filePath).toBe('/src/app.ts#edit-0');
            expect(records[1].filePath).toBe('/src/app.ts#edit-1');
            expect(JSON.parse(records[0].diff)).toEqual({ oldString: 'a', newString: 'b' });
            expect(JSON.parse(records[1].diff)).toEqual({ oldString: 'c', newString: 'd' });
        });

        it('returns block unchanged if edits array is empty', () => {
            const block = {
                type: 'tool_use',
                id: 'call-789',
                name: 'MultiEdit',
                input: { file_path: '/src/app.ts', edits: [] },
            };
            expect(trimToolUseInput(block, 'session-3')).toBe(block);
        });
    });

    describe('other tools', () => {
        it('returns block unchanged for Bash', () => {
            const block = {
                type: 'tool_use',
                id: 'call-000',
                name: 'Bash',
                input: { command: 'ls' },
            };
            expect(trimToolUseInput(block, 'session-1')).toBe(block);
            expect(mockSave).not.toHaveBeenCalled();
        });

        it('returns block unchanged for Read', () => {
            const block = {
                type: 'tool_use',
                id: 'call-001',
                name: 'Read',
                input: { file_path: '/src/app.ts' },
            };
            expect(trimToolUseInput(block, 'session-1')).toBe(block);
        });
    });
});
