/** Recover bodies that older relay protocols never retained; no command is executed. */
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { getProjectPath } from '@/claude/utils/path';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import { withCodexAccountThread } from '@/codex/codexAccountThread';

export type NativeToolResultSource = {
    id: string; agent: 'claude' | 'codex'; nativeId: string; directory: string; accountProfileId?: string; revision?: number;
    boundaryId?: string; connectionKey?: string;
};
export type NativeToolResultPage = { outputText: string; isError: boolean; exitCode?: number; nextTextOffset: number | null };
const serialize = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value ?? null);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// Data pages for one immutable source frontier share a native read. Bounded
// action-driven caches avoid launching an app-server for every 16k text page.
const resultReads = new Map<string, Promise<{ text: string; isError: boolean; exitCode?: number }>>();
const threadReads = new Map<string, Promise<any>>();
function remember<T>(cache: Map<string, Promise<T>>, key: string, read: () => Promise<T>, capacity: number): Promise<T> {
    const existing = cache.get(key);
    if (existing) { cache.delete(key); cache.set(key, existing); return existing; }
    const task = read(); cache.set(key, task);
    if (cache.size > capacity) cache.delete(cache.keys().next().value!);
    void task.catch(() => { if (cache.get(key) === task) cache.delete(key); });
    return task;
}

export async function readClaudeNativeToolResult(path: string, callId: string): Promise<{ text: string; isError: boolean; exitCode?: number }> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const initial = await file.stat();
        if (!initial.isFile() || initial.size > 256 * 1024 * 1024) throw new Error('Native tool history unavailable or exceeds recovery resource limit');
        const nodes = new Map<string, { parent: string | null; compact: boolean }>();
        const results = new Map<string, { text: string; isError: boolean; exitCode?: number }>();
        let leaf: string | undefined;
        const lines = createInterface({ input: file.createReadStream({ autoClose: false }), crlfDelay: Infinity });
        for await (const line of lines) {
            if (!line.trim()) continue;
            let row: any;
            try { row = JSON.parse(line); } catch { throw new Error('Native tool history contains an unreadable record'); }
            if (typeof row.uuid !== 'string') continue;
            nodes.set(row.uuid, { parent: row.parentUuid ?? null, compact: row.type === 'system' && row.subtype === 'compact_boundary' });
            if (row.isSidechain) continue;
            if (row.type === 'user' || row.type === 'assistant') leaf = row.uuid;
            if (row.type !== 'user' || !Array.isArray(row.message?.content)) continue;
            const block = row.message.content.find((block: any) => block.type === 'tool_result' && block.tool_use_id === callId);
            if (!block) continue;
            const exitCode = row.toolUseResult?.exitCode ?? row.toolUseResult?.exit_code;
            results.set(row.uuid, {
                text: row.toolUseResult !== undefined ? serialize({ content: block.content, toolUseResult: row.toolUseResult }) : serialize(block.content),
                isError: block.is_error === true || (Number.isInteger(exitCode) && exitCode !== 0) || row.toolUseResult?.interrupted === true,
                ...(Number.isInteger(exitCode) ? { exitCode } : {}),
            });
        }
        const final = await file.stat();
        if (final.size !== initial.size || final.mtimeMs !== initial.mtimeMs) throw new Error('Native tool history changed while being read');
        const seen = new Set<string>();
        for (let id = leaf; id;) {
            if (seen.has(id) || !nodes.has(id)) throw new Error('Native tool history branch is incomplete');
            seen.add(id);
            const result = results.get(id);
            if (result) return result;
            const node = nodes.get(id)!;
            if (node.compact) break;
            id = node.parent ?? undefined;
        }
        throw new Error('The original tool result is not retained in the current native branch');
    } finally { await file.close(); }
}

export function codexNativeToolResult(thread: any, nativeId: string, callId: string): { text: string; isError: boolean; exitCode?: number } {
    if (thread.id !== nativeId || !Array.isArray(thread.turns)) throw new Error('Native Codex tool history identity mismatch');
    for (const turn of thread.turns) {
        for (const item of turn.items ?? []) {
            if (item.id !== callId && item.callId !== callId && item.call_id !== callId) continue;
            if (item.status === 'inProgress' || turn.status === 'inProgress') throw new Error('Wait for the original native tool to finish');
            if (item.type === 'commandExecution') {
                if (typeof item.aggregatedOutput !== 'string') throw new Error('The original command output was not retained by Codex');
                return { text: item.aggregatedOutput, isError: item.status === 'failed' || item.status === 'declined' || (item.exitCode != null && item.exitCode !== 0),
                    ...(Number.isInteger(item.exitCode) ? { exitCode: item.exitCode } : {}) };
            }
            if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
                const output = item.result ?? item.output ?? item.contentItems ?? item.error;
                if (output === undefined) throw new Error('The original native tool result was not retained by Codex');
                return { text: serialize(output), isError: item.status === 'failed' || !!item.error || item.success === false };
            }
            if (item.type === 'fileChange' || item.type === 'webSearch' || item.type === 'imageView' || item.type === 'imageGeneration'
                || item.type === 'collabAgentToolCall' || item.type === 'subAgentActivity') return { text: serialize(item), isError: item.status === 'failed' };
        }
    }
    throw new Error('The original tool result is not retained in the current native thread');
}

export async function readNativeToolResult(source: NativeToolResultSource, callId: string, textOffset = 0): Promise<NativeToolResultPage> {
    if (!uuid.test(source.nativeId) || !source.id || !callId || callId.length > 1024 || !Number.isSafeInteger(textOffset) || textOffset < 0) throw new Error('Invalid native history recovery request');
    const directory = await realpath(source.directory);
    const sourceKey = JSON.stringify([source.id, source.agent, source.nativeId, directory, source.accountProfileId ?? null,
        source.revision ?? null, source.boundaryId ?? null, source.connectionKey ?? null]);
    let result: { text: string; isError: boolean; exitCode?: number };
    if (source.agent === 'claude') result = await remember(resultReads, `${sourceKey}:${callId}`,
        () => readClaudeNativeToolResult(join(getProjectPath(directory), `${source.nativeId}.jsonl`), callId), 2);
    else {
        const read = async (client: CodexAppServerClient) => {
            const { thread } = await client.readThread({ threadId: source.nativeId, includeTurns: true });
            if (thread.cwd && await realpath(thread.cwd) !== directory) throw new Error('Native history working directory mismatch');
            if (Buffer.byteLength(JSON.stringify(thread)) > 128 * 1024 * 1024) throw new Error('Native tool history exceeds recovery resource limit');
            return thread;
        };
        const thread = await remember(threadReads, sourceKey, async () => {
            if (source.accountProfileId) return withCodexAccountThread({ sourceSessionId: source.id, codexThreadId: source.nativeId }, read);
            const client = new CodexAppServerClient(undefined, { type: 'spawn' }, process.env);
            try { await client.connect(); return await read(client); }
            finally { await client.disconnect(); }
        }, 2);
        result = codexNativeToolResult(thread, source.nativeId, callId);
    }
    if (textOffset > result.text.length) throw new Error('Native history text offset exceeds retained result');
    const end = Math.min(textOffset + 16000, result.text.length);
    return { outputText: result.text.slice(textOffset, end), isError: result.isError,
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}), nextTextOffset: end < result.text.length ? end : null };
}
