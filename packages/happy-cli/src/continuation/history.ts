import { randomUUID } from 'node:crypto';
import type { Thread } from '@/codex/codexAppServerTypes';
import { stripPawsTurnOrigin } from '@/codex/codexPrompt';

/** Portable historical records. These are never passed to a live tool executor. */
export type ConversationItem =
    | { kind: 'user' | 'assistant'; text: string; images?: string[] }
    | { kind: 'tool'; name: string; input: string; command?: string; cwd?: string; output: string; error: boolean };
const MAX_OUTPUT = 64 * 1024;
export function cleanUserText(text: string): string {
    return stripPawsTurnOrigin(text.replace(/<!-- happy:system-prompt:start -->[\s\S]*?<!-- happy:system-prompt:end -->/g, '')).trim();
}
const outputText = (v: unknown): string => typeof v === 'string' ? v : Array.isArray(v)
    ? v.map(x => typeof x?.text === 'string' ? x.text : JSON.stringify(x)).join('\n') : JSON.stringify(v ?? '');
const boundedOutput = (v: unknown): string => { const text = outputText(v); return text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + '\n[historical tool output truncated]' : text; };
const note = (item: Extract<ConversationItem, { kind: 'tool' }>) => `[Historical ${item.name}]\n${item.input}\n[${item.error ? 'error' : 'result'}]\n${item.output}`;

export function readClaudeConversation(rows: any[]): ConversationItem[] {
    const nodes = new Map<string, any>(); let leaf: string | undefined;
    for (const row of rows) {
        if (typeof row.uuid !== 'string') continue;
        nodes.set(row.uuid, row);
        if (!row.isSidechain && ['user', 'assistant'].includes(row.type)) leaf = row.uuid;
    }
    const chain: any[] = []; const seen = new Set<string>();
    for (let id = leaf; id;) {
        if (seen.has(id) || !nodes.has(id)) throw new Error('Claude history chain is incomplete');
        seen.add(id); const row = nodes.get(id); chain.push(row);
        // Native compaction intentionally starts a new context chain.
        if (row.type === 'system' && row.subtype === 'compact_boundary') break;
        id = row.parentUuid ?? undefined;
    }
    const out: ConversationItem[] = []; const calls = new Map<string, Extract<ConversationItem, { kind: 'tool' }>>();
    const done = new Set<string>();
    for (const row of chain.reverse()) {
        if (row.isSidechain || row.isMeta || !['user', 'assistant'].includes(row.type)) continue;
        const content = row.message?.content;
        if (typeof content === 'string') {
            const text = row.type === 'user' ? cleanUserText(content) : content;
            if (text && !(row.type === 'user' && /^<(command-name|command-message|command-args|local-command-|system-reminder)/.test(text))) out.push({ kind: row.type, text });
            continue;
        }
        if (!Array.isArray(content)) throw new Error('Unsupported Claude message content');
        let text: string[] = []; const images: string[] = [];
        for (const block of content) {
            switch (block.type) {
                case 'text':
                    if (row.type === 'user') text.push(cleanUserText(block.text));
                    else out.push({ kind: 'assistant', text: block.text });
                    break;
                case 'image':
                    if (row.type !== 'user' || block.source?.type !== 'base64') throw new Error('Unsupported historical image');
                    images.push(`data:${block.source.media_type};base64,${block.source.data}`); break;
                case 'tool_use': {
                    const item: Extract<ConversationItem, { kind: 'tool' }> = { kind: 'tool', name: block.name, input: JSON.stringify(block.input),
                        ...(block.name === 'Bash' && typeof block.input?.command === 'string' ? { command: block.input.command } : {}), output: '', error: false };
                    if (calls.has(block.id)) throw new Error('Duplicate historical tool call');
                    calls.set(block.id, item); out.push(item); break;
                }
                case 'tool_result': {
                    const call = calls.get(block.tool_use_id);
                    if (!call || done.has(block.tool_use_id)) throw new Error('Historical tool result has no matching call');
                    call.output = boundedOutput(block.content); call.error = block.is_error === true; done.add(block.tool_use_id); break;
                }
                case 'thinking': case 'redacted_thinking': break;
                default: throw new Error(`Unsupported Claude history block: ${block.type}`);
            }
        }
        if (row.type === 'user' && (text.some(Boolean) || images.length)) out.push({ kind: 'user', text: text.filter(Boolean).join('\n\n'), ...(images.length ? { images } : {}) });
    }
    if ([...calls.keys()].some(id => !done.has(id))) throw new Error('Cannot continue an unfinished tool call without its result');
    return out;
}

export function readCodexConversation(thread: Thread): ConversationItem[] {
    if (!Array.isArray(thread.turns)) throw new Error('Codex history is unavailable');
    const out: ConversationItem[] = [];
    for (const turn of thread.turns) {
        if (turn.status === 'inProgress') throw new Error('Wait for the source turn to finish');
        if (turn.itemsView && JSON.stringify(turn.itemsView).includes('hasMore":true')) throw new Error('Codex history is incomplete');
        for (const item of turn.items) {
            switch (item.type) {
                case 'userMessage': {
                    const content = (item as any).content as any[];
                    const images: string[] = []; const words: string[] = [];
                    for (const part of content) {
                        if (part.type === 'text') words.push(cleanUserText(part.text));
                        else if (part.type === 'image') images.push(part.url);
                        else if (part.type === 'localImage') images.push(`file:${part.path}`);
                        else throw new Error(`Unsupported Codex user content: ${part.type}`);
                    }
                    out.push({ kind: 'user', text: words.filter(Boolean).join('\n'), ...(images.length ? { images } : {}) }); break;
                }
                case 'agentMessage': out.push({ kind: 'assistant', text: (item as any).text }); break;
                case 'commandExecution': {
                    const command = item as any;
                    if (command.status === 'inProgress' || command.aggregatedOutput == null) throw new Error('Unfinished historical command result');
                    out.push({ kind: 'tool', name: 'exec_command', input: JSON.stringify({ cmd: command.command, workdir: command.cwd }), command: command.command,
                        cwd: command.cwd, output: boundedOutput(command.aggregatedOutput), error: command.exitCode != null && command.exitCode !== 0 }); break;
                }
                case 'fileChange': case 'mcpToolCall': case 'webSearch': case 'imageView': case 'imageGeneration': case 'collabAgentToolCall': case 'dynamicToolCall':
                    if ((item as any).status === 'inProgress') throw new Error('Unfinished historical tool call');
                    out.push({ kind: 'assistant', text: `[Historical ${item.type}]\n${boundedOutput(item)}` }); break;
                case 'reasoning': case 'contextCompaction': case 'enteredReviewMode': case 'exitedReviewMode': break;
                default: throw new Error(`Unsupported Codex history item: ${item.type}`);
            }
        }
    }
    return out;
}

export function toCodexItems(history: ConversationItem[], cwd: string): unknown[] {
    return history.flatMap((item): unknown[] => {
        if (item.kind === 'tool') {
            if (!item.command) return [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: note(item) }] }];
            const id = `call_${randomUUID().replaceAll('-', '')}`;
            return [{ type: 'function_call', name: 'exec_command', call_id: id, arguments: JSON.stringify({ cmd: item.command, workdir: item.cwd ?? cwd }) },
                { type: 'function_call_output', call_id: id, output: item.error ? `[error]\n${item.output}` : item.output }];
        }
        return [{ type: 'message', role: item.kind, content: [
            ...(item.text ? [{ type: item.kind === 'user' ? 'input_text' : 'output_text', text: item.text }] : []),
            ...(item.images ?? []).map(image => ({ type: 'input_image', image_url: image })),
        ] }];
    });
}

export function toClaudeLines(history: ConversationItem[], options: { id: string; cwd: string }): unknown[] {
    const rows: any[] = []; let parentUuid: string | null = null;
    const add = (role: 'user' | 'assistant', content: unknown, extra: object = {}) => {
        const uuid = randomUUID();
        rows.push({ parentUuid, isSidechain: false, type: role, uuid, sessionId: options.id, cwd: options.cwd, userType: 'external',
            version: '2.0.0', timestamp: new Date().toISOString(), ...extra,
            message: role === 'user' ? { role, content } : { id: `msg_${randomUUID()}`, type: 'message', role, model: '<synthetic>', content,
                stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
        parentUuid = uuid; return uuid;
    };
    for (const item of history) {
        if (item.kind === 'tool') {
            if (!item.command) { add('assistant', [{ type: 'text', text: note(item) }]); continue; }
            const id = `toolu_${randomUUID().replaceAll('-', '')}`;
            const command = item.cwd && item.cwd !== options.cwd ? `cd '${item.cwd.replaceAll("'", "'\\''")}' && ${item.command}` : item.command;
            const by = add('assistant', [{ type: 'tool_use', id, name: 'Bash', input: { command } }]);
            rows[rows.length - 1].message.stop_reason = 'tool_use';
            add('user', [{ type: 'tool_result', tool_use_id: id, content: item.output, is_error: item.error }],
                { sourceToolAssistantUUID: by, toolUseResult: { stdout: item.output, stderr: '', interrupted: false, isImage: false } });
        } else if (item.kind === 'assistant') add('assistant', [{ type: 'text', text: item.text }]);
        else {
            const images = (item.images ?? []).map(image => {
                const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(image);
                if (!match) throw new Error('Historical image must be materialized before import');
                return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
            });
            add('user', images.length ? [...(item.text ? [{ type: 'text', text: item.text }] : []), ...images] : item.text);
        }
    }
    return rows;
}
