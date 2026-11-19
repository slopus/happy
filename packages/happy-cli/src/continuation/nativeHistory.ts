import { readImportPrefix, writeImportPrefix } from './importPrefix';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, rename, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getProjectPath } from '@/claude/utils/path';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import { withCodexAccountThread } from '@/codex/codexAccountThread';
import { readClaudeConversation, readCodexConversation, toClaudeLines, toCodexItems, type ConversationItem } from './history';

const MAX_HISTORY = 32 * 1024 * 1024;
async function readPrivateFile(path: string, max = MAX_HISTORY): Promise<Buffer> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > max) throw new Error('Historical file is unavailable or exceeds the import size limit');
        const data = Buffer.alloc(stat.size); let offset = 0;
        while (offset < data.length) {
            const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
            if (!bytesRead) throw new Error('Historical file changed while being read');
            offset += bytesRead;
        }
        if ((await file.stat()).size !== stat.size) throw new Error('Historical file changed while being read');
        return data;
    } finally { await file.close(); }
}

export async function exportNativeConversation(source: { id: string; agent: 'claude' | 'codex'; nativeId: string; directory: string; accountProfileId?: string; requiresImportedHistory?: boolean }): Promise<ConversationItem[]> {
    let history: ConversationItem[];
    if (source.agent === 'claude') {
        if (!/^[a-f0-9-]{36}$/i.test(source.nativeId)) throw new Error('Invalid Claude session ID');
        const data = await readPrivateFile(join(getProjectPath(source.directory), `${source.nativeId}.jsonl`));
        history = readClaudeConversation(data.toString('utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line)));
    } else {
        const read = async (client: CodexAppServerClient) => {
            const { thread } = await client.readThread({ threadId: source.nativeId, includeTurns: true });
            if (thread.id !== source.nativeId || (thread.cwd && await realpath(thread.cwd) !== await realpath(source.directory))) throw new Error('Source native session identity changed');

            // Retain the portable prefix and exclude its synthetic native turn
            // so repeated cross-agent conversion neither loses nor duplicates it.
            const inherited = await readImportPrefix(source.nativeId, source.requiresImportedHistory);
            if (inherited && inherited.directory !== source.directory) throw new Error('Imported history directory mismatch');
            const importedTurns = new Set(inherited?.turnIds ?? []);
            const recent = readCodexConversation({ ...thread, turns: thread.turns?.filter(turn => !importedTurns.has(turn.id)) });
            return [...(inherited?.history ?? []), ...recent];
        };
        if (source.accountProfileId) history = await withCodexAccountThread({ sourceSessionId: source.id, codexThreadId: source.nativeId }, read);
        else {
            const client = new CodexAppServerClient(undefined, { type: 'spawn' }, process.env);
            try { await client.connect(); history = await read(client); }
            finally { await client.disconnect(); }
        }
    }
    if (!history.some(x => x.kind === 'user')) throw new Error('Source session has no recoverable user history');
    let bytes = Buffer.byteLength(JSON.stringify(history));
    for (const item of history) {
        if (item.kind !== 'user') continue;
        for (let i = 0; i < (item.images?.length ?? 0); i++) {
            const image = item.images![i];
            if (image.startsWith('file:')) {
                const path = image.slice(5);
                if (!path.startsWith('/')) throw new Error('Historical image path must be absolute');
                const data = await readPrivateFile(path, 10 * 1024 * 1024);
                const type = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png'
                    : data[0] === 255 && data[1] === 216 ? 'jpeg'
                    : data.subarray(0, 3).toString() === 'GIF' ? 'gif'
                    : data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP' ? 'webp' : null;
                if (!type) throw new Error('Unsupported historical image format');
                item.images![i] = `data:image/${type};base64,${data.toString('base64')}`;
                bytes += item.images![i].length;
            } else if (!/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(image)) throw new Error('Historical image is unavailable locally');
            if (bytes > MAX_HISTORY) throw new Error('Conversation exceeds the native import size limit (32 MiB)');
        }
    }
    if (bytes > MAX_HISTORY || history.length > 50_000) throw new Error('Conversation exceeds the native import size limit');
    return history;
}

export async function importClaudeConversation(history: ConversationItem[], directory: string): Promise<string> {
    const id = randomUUID(); const project = getProjectPath(directory);
    await mkdir(project, { recursive: true, mode: 0o700 });
    const path = join(project, `${id}.jsonl`); const temp = `${path}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try {
        await file.writeFile(toClaudeLines(history, { id, cwd: directory }).map(row => JSON.stringify(row)).join('\n') + '\n');
        await file.sync(); await file.close(); await rename(temp, path);
        return id;
    } catch (error) { await file.close().catch(() => undefined); await rm(temp, { force: true }); throw error; }
}

/** Create an independent legacy rollout, as native Codex resume supports.
 * Using inject_items would redact image bytes and omit projected conversation
 * turns. A fresh rollout avoids touching an existing account thread/index.
 */
export async function importCodexConversation(history: ConversationItem[], directory: string, env: NodeJS.ProcessEnv): Promise<string> {
    const id = randomUUID(); const turnId = randomUUID();
    const now = new Date(); const stamp = now.toISOString();
    const date = stamp.slice(0, 10);
    const folder = join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions', ...date.split('-'));
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const path = join(folder, `rollout-${date}T${stamp.slice(11, 19).replaceAll(':', '-')}-${id}.jsonl`);
    const rows: unknown[] = [];
    const add = (type: string, payload: unknown) => rows.push({ timestamp: stamp, type, payload });
    add('session_meta', { id, session_id: id, timestamp: stamp, cwd: directory, originator: 'codex_cli_rs', cli_version: '0.0.0', source: 'cli' });
    add('event_msg', { type: 'task_started', turn_id: turnId, model_context_window: null });
    for (const item of toCodexItems(history, directory) as any[]) {
        add('response_item', item);
        if (item.type === 'message' && item.role === 'user') add('event_msg', { type: 'user_message', message: item.content.filter((x: any) => x.type === 'input_text').map((x: any) => x.text).join('\n'), images: item.content.filter((x: any) => x.type === 'input_image').map((x: any) => x.image_url), local_images: [], text_elements: [] });
        else if (item.type === 'message' && item.role === 'assistant') add('event_msg', { type: 'agent_message', message: item.content.map((x: any) => x.text).join('\n') });
    }
    add('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: null });
    const temp = `${path}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try {
        await file.writeFile(rows.map(row => JSON.stringify(row)).join('\n') + '\n'); await file.sync(); await file.close();
        await writeImportPrefix(id, { directory, history, turnIds: [turnId] });
        await rename(temp, path);
    } catch (error) { await file.close().catch(() => undefined); await rm(temp, { force: true }); throw error; }
    return id;
}
