import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexNativeToolResult, readClaudeNativeToolResult } from './recoverToolResult';
const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('recovering original legacy native tool bodies', () => {
    it('reads the complete Claude tool result with exit status, excluding another branch and private reasoning', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'portable-tool-native-')); cleanup.push(dir);
        const path = join(dir, 'native.jsonl');
        const output = 'x'.repeat(90000) + 'EXACT_LAST_BYTE';
        await writeFile(path, [
            { uuid: 'u', parentUuid: null, type: 'user', message: { content: 'task' } },
            { uuid: 'a', parentUuid: 'u', type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'PRIVATE' }, { type: 'tool_use', id: 'call', name: 'Bash', input: { command: 'fixture' } }] } },
            { uuid: 'wrong', parentUuid: 'a', type: 'user', isSidechain: true, message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'WRONG' }] } },
            { uuid: 'r', parentUuid: 'a', type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: output, is_error: true }] }, toolUseResult: { stdout: output, exitCode: 17 } },
        ].map(row => JSON.stringify(row)).join('\n'));
        const result = await readClaudeNativeToolResult(path, 'call');
        expect(result.text).toContain(output);
        expect(result.text).not.toContain('PRIVATE');
        expect(result.text).not.toContain('WRONG');
        expect(result).toMatchObject({ isError: true, exitCode: 17 });
    });
    it('refuses absent or excluded-branch results and non-regular/symlink native files', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'portable-tool-native-')); cleanup.push(dir);
        const path = join(dir, 'native.jsonl');
        await writeFile(path, [
            { uuid: 'u', parentUuid: null, type: 'user', message: { content: 'task' } },
            { uuid: 'old', parentUuid: 'u', type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'old-call', content: 'excluded' }] } },
            { uuid: 'new', parentUuid: 'u', type: 'assistant', message: { content: [] } },
        ].map(row => JSON.stringify(row)).join('\n'));
        await expect(readClaudeNativeToolResult(path, 'old-call')).rejects.toThrow('not retained');
        await symlink(path, join(dir, 'linked'));
        await expect(readClaudeNativeToolResult(join(dir, 'linked'), 'old-call')).rejects.toThrow();
        await expect(readClaudeNativeToolResult(dir, 'old-call')).rejects.toThrow('unavailable');
    });
    it('keeps Codex command output and JSON MCP results without executing or truncating them', () => {
        const output = '中'.repeat(90000) + 'NATIVE_TAIL';
        const thread = { id: 'native', turns: [{ status: 'completed', items: [
            { id: 'cmd', type: 'commandExecution', status: 'failed', aggregatedOutput: output, exitCode: 9 },
            { id: 'mcp', type: 'mcpToolCall', status: 'completed', result: { content: [{ type: 'text', text: output }] } },
        ] }] };
        expect(codexNativeToolResult(thread, 'native', 'cmd')).toEqual({ text: output, isError: true, exitCode: 9 });
        expect(JSON.parse(codexNativeToolResult(thread, 'native', 'mcp').text).content[0].text).toBe(output);
        expect(() => codexNativeToolResult(thread, 'other', 'cmd')).toThrow('identity');
    });
    it('never treats a missing native output or running tool as an empty successful result', () => {
        const thread = { id: 'native', turns: [{ status: 'completed', items: [{ id: 'cmd', type: 'commandExecution', status: 'completed', exitCode: 0 }] }] };
        expect(() => codexNativeToolResult(thread, 'native', 'cmd')).toThrow('not retained');
        thread.turns[0].status = 'inProgress';
        expect(() => codexNativeToolResult(thread, 'native', 'cmd')).toThrow('finish');
    });
});
