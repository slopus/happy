// Runs only in an explicitly prepared, private isolated HAPPY_HOME_DIR.
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync, watch } from 'node:fs';
import { PawsAgentClient } from '../../../paws-agent/dist/index.mjs';
const home = process.env.HAPPY_HOME_DIR;
if (!home || !home.includes('paws-independent-live-')) throw new Error('An isolated verification home is required');
const account = JSON.parse(await readFile(`${home}/access.key`, 'utf8'));
const settings = JSON.parse(await readFile(`${home}/settings.json`, 'utf8'));
const scoped = () => { try { return JSON.parse(readFileSync(`${home}/sessions.json`, 'utf8')).sessions ?? {}; } catch { return {}; } };
const output = { startedAt: new Date().toISOString(), machineId: settings.machineId, parentSessionId: null, sessions: {}, errors: [] };
const credentials = { token: account.token, resolveRecordKey(record) {
    if (record.type === 'machine') return record.id === settings.machineId ? { key: Buffer.from(account.encryption.machineKey, 'base64'), variant: 'dataKey' } : null;
    const session = scoped()[record.id];
    return session ? { key: Buffer.from(session.encryptionKey, 'base64'), variant: session.encryptionVariant } : null;
} };
const client = new PawsAgentClient({ serverUrl: settings.serverUrl, credentials: { getCredentials: async () => credentials } });
const subscriptions = new Map();
let accepting = true;
let resolveFinished;
const finished = new Promise(resolve => { resolveFinished = resolve; });
const save = async () => writeFile(`${home}/result.json`, JSON.stringify(output, null, 2), { mode: 0o600 });
const summarize = message => {
    const record = message.content;
    if (record?.role === 'session') {
        const ev = record.content?.ev;
        if (ev?.t === 'text') return { kind: 'text', time: record.content.time, role: record.content.role, text: ev.text ?? ev.content ?? '', seq: message.seq };
        if (ev?.t === 'tool-call-start') return { kind: 'tool', time: record.content.time, name: ev.name, seq: message.seq };
        if (ev?.t === 'turn-start') return { kind: 'turn-start', time: record.content.time, seq: message.seq };
        if (ev?.t === 'turn-end') return { kind: 'turn-end', time: record.content.time, status: ev.status, seq: message.seq };
    }
    return null;
};
function checkFinished() {
    const sessions = Object.values(output.sessions);
    const parent = output.sessions[output.parentSessionId];
    const children = sessions.filter(s => s.parentSessionId === output.parentSessionId);
    if (parent?.status === 'completed' && children.length === 2 && children.every(s => s.status === 'completed')) resolveFinished('completed');
}
const attach = async id => {
    if (!accepting || subscriptions.has(id)) return;
    const saved = scoped()[id];
    if (id !== output.parentSessionId && saved?.metadata?.parentSessionId !== output.parentSessionId) return;
    subscriptions.set(id, null);
    output.sessions[id] ??= { parentSessionId: saved?.metadata?.parentSessionId ?? null, messages: [] };
    try {
        const snapshot = await client.sessions.get(id);
        updateSession(snapshot);
        const subscription = await client.messages.watch(id, {
            afterSeq: 0,
            onMessage(message) {
                const summary = summarize(message);
                if (summary) { output.sessions[id].messages.push(summary); console.log(JSON.stringify({ sessionId: id, ...summary })); }
                if (summary?.kind === 'turn-end') { output.sessions[id].status = summary.status; checkFinished(); }
                void save();
            },
            onError(error) { output.errors.push({ sessionId: id, code: error.code, message: error.message }); console.log(JSON.stringify({ error: error.code, sessionId: id })); },
        });
        if (accepting) subscriptions.set(id, subscription); else subscription.unsubscribe();
    } catch (error) { subscriptions.delete(id); output.errors.push({ stage: 'attach', sessionId: id, message: error.message }); }
};
function updateSession(session) {
    const saved = scoped()[session.id];
    if (!saved) return;
    const entry = output.sessions[session.id] ??= { messages: [] };
    Object.assign(entry, { parentSessionId: session.metadata?.parentSessionId ?? null, model: session.metadata?.currentModelCode,
        effort: session.metadata?.currentThoughtLevelCode, permissionMode: session.metadata?.currentOperatingModeCode,
        status: session.agentState?.turnStatus?.status, active: session.active });
    checkFinished(); void save();
}
const fileWatcher = watch(home, (_event, name) => {
    if (name === 'sessions.json') for (const id of Object.keys(scoped())) void attach(id);
});
const unsubscribe = client.subscribe(event => {
    if (event.type === 'session') updateSession(event.session);
    if (event.type === 'request' && scoped()[event.sessionId]) console.log(JSON.stringify({ pendingRequest: event.sessionId, type: event.request.type }));
});
const timeout = setTimeout(() => resolveFinished('timeout'), 240000);
try {
    await client.connect();
    const spawned = process.env.PAWS_TEST_PARENT_ID ? { type: 'success', sessionId: process.env.PAWS_TEST_PARENT_ID } : await client.sessions.spawn({ machineId: settings.machineId, directory: `${home}/tasks`, agent: 'codex', model: 'gpt-6.1-sol', effort: 'low' });
    if (spawned.type !== 'success') throw new Error(JSON.stringify(spawned));
    output.parentSessionId = spawned.sessionId;
    await attach(spawned.sessionId);
    console.log(JSON.stringify({ parentCreated: spawned.sessionId, machineId: settings.machineId }));
    await client.messages.send({ sessionId: spawned.sessionId, localId: process.env.PAWS_TEST_MESSAGE_ID ?? 'independent-live-parent-20261022',
        text: `这是 Paws 独立会话真实联调。请立即使用 Happy MCP start_session 工具开启两个独立 Codex 会话，可并行调用。不要用 collaboration 子agent，不要自己读取文件，不要运行shell，不要写代码。\n任务1：requestId=live-alpha-20261022，title=真实联调 Alpha，directory=${home}/tasks，prompt=只读任务：读取当前目录alpha.txt，只回复该文件中的完整一行，不改任何文件，不启动其他会话。\n任务2：requestId=live-beta-20261022，title=真实联调 Beta，directory=${home}/tasks，prompt=只读任务：读取当前目录beta.txt，只回复该文件中的完整一行，不改任何文件，不启动其他会话。\n创建成功后，将工具实际返回的两个<happy-session>块逐字放入最终回复，不等待子任务完成，不伪造sessionId。`,
        configuration: { model: 'gpt-6.1-sol', effort: 'low' },
        meta: { permissionMode: 'read-only', permissionModeExplicit: true },
    });
    output.outcome = await finished;
    for (const id of Object.keys(output.sessions)) {
        const session = await client.sessions.get(id); updateSession(session);
        const history = await client.messages.history(id, { limit: 500 });
        output.sessions[id].messages = history.map(summarize).filter(Boolean);
    }
    const children = Object.entries(output.sessions).filter(([, value]) => value.parentSessionId === output.parentSessionId);
    output.validation = { childCount: children.length, repliesMatch: children.length === 2 };
    for (const [id, child] of children) {
        const texts = child.messages.filter(m => m.kind === 'text' && m.role === 'agent').map(m => m.text);
        const name = texts.some(text => text.includes('ALPHA-')) ? 'alpha' : 'beta';
        const expected = (await readFile(`${home}/tasks/${name}.txt`, 'utf8')).trim();
        child.replyMatchesFile = texts.some(text => text.trim() === expected);
        output.validation.repliesMatch &&= child.replyMatchesFile;
    }
    const parentText = output.sessions[output.parentSessionId]?.messages.filter(m => m.kind === 'text' && m.role === 'agent').map(m => m.text).join('\n') ?? '';
    output.validation.parentHasBothLinks = children.length === 2 && children.every(([id]) => parentText.includes(id)) && parentText.includes('<happy-session>');
    if (children.length === 2) {
        const intervals = children.map(([, s]) => [s.messages.find(m => m.kind === 'turn-start')?.time, s.messages.find(m => m.kind === 'turn-end')?.time]);
        output.validation.overlappingExecution = intervals.every(t => t.every(Number.isFinite)) && Math.max(...intervals.map(t => t[0])) < Math.min(...intervals.map(t => t[1]));
    }
    output.completedAt = new Date().toISOString();
    await save();
    console.log(JSON.stringify({ outcome: output.outcome, sessions: Object.fromEntries(Object.entries(output.sessions).map(([id, s]) => [id, { parentSessionId: s.parentSessionId, status: s.status, model: s.model, permissionMode: s.permissionMode }])) }));
} catch (error) {
    output.outcome = 'error'; output.errors.push({ stage: 'run', message: error.message }); await save(); console.log(JSON.stringify({ error: error.message }));
} finally {
    accepting = false; clearTimeout(timeout); fileWatcher.close(); unsubscribe();
    for (const subscription of subscriptions.values()) subscription?.unsubscribe();
    await client.dispose();
}
