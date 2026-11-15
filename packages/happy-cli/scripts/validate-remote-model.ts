/** Opt-in live PR #1844 smoke. Run through validate-remote-model.py. */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import axios from 'axios';
import { io } from 'socket.io-client';
import { ApiClient } from '../src/api/api';
import { SDKToLogConverter } from '../src/claude/utils/sdkToLogConverter';
import { readCredentials } from '../src/persistence';
import { configuration } from '../src/configuration';
import { encrypt, decrypt, encodeBase64, decodeBase64 } from '../src/api/encryption';
import { runClaude } from '../src/claude/runClaude';

const out = resolve(process.argv[2]);
const requested = process.argv[3] || 'opus';
const expected = requested === 'opus' ? 'claude-opus-5-5' : requested;
mkdirSync(out, { recursive: true });
const fixture = join(out, 'project');
mkdirSync(fixture, { recursive: true });
const report: any = { startedAt: new Date().toISOString(), node: process.version, scope: 'live-native-local-to-Happy-remote-via-real-relay; native local print/stream mode; headless app transport; no visual app verification', requested, expected,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sdk: JSON.parse(readFileSync(join(dirname(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'), 'utf8')).version,
    claude: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(),
    remote: [], metadata: [], relayEvents: [], status: 'running' };
const save = () => writeFileSync(join(out, 'evidence.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
save();
const credentials = await readCredentials();
if (!credentials) throw new Error('Happy credentials unavailable');
const headers = { Authorization: `Bearer ${credentials.token}`, 'X-Happy-Client': 'pr1844-live-smoke' };
let session: any;
let observer: ReturnType<typeof io> | undefined;
let finished = false;
let remoteSent = 0;
let localStarted = false;
let activeInit: any;
const failure = (e: any) => e?.response ? `HTTP ${e.response.status}` : String(e?.message || e).replace(/Bearer\s+\S+/g, 'Bearer [redacted]');
function finish(status: string, reason?: string) {
    if (finished) return;
    finished = true;
    report.status = status; report.reason = reason; report.finishedAt = new Date().toISOString(); save();
    console.log('PR1844_FINISHED ' + status);
    observer?.disconnect();
    // runClaude's own SIGINT cleanup archives only this newly-created session.
    process.kill(process.pid, 'SIGINT');
}
async function sendRemote() {
    const n = ++remoteSent;
    report.remote.push({ turn: n, initModel: activeInit?.model, sessionId: activeInit?.session_id, assistants: [] });
    const raw = { role: 'user', content: { type: 'text', text: `Reply with exactly PR1844_REMOTE_${n}. Do not call tools.` }, meta: { sentFrom: 'web' } };
    // Deliberately omit meta.model: this verifies the preserved local selection.
    await axios.post(`${configuration.serverUrl}/v3/sessions/${session.id}/messages`, { messages: [{ localId: randomUUID(), content: encodeBase64(encrypt(session.encryptionKey, session.encryptionVariant, raw)) }] }, { headers, timeout: 20_000 });
    report.relayEvents.push({ kind: 'remote-prompt-accepted', turn: n, omittedModelOverride: true, at: new Date().toISOString() }); save();
}
const originalSync = ApiClient.prototype.sessionSyncClient;
ApiClient.prototype.sessionSyncClient = function (s: any, ...args: any[]) {
    session = s;
    report.happySessionId = s.id;
    observer = io(configuration.serverUrl, { path: '/v1/updates', auth: { token: credentials.token, clientType: 'user-scoped', happyClient: 'pr1844-live-smoke', appState: 'active' }, transports: ['websocket'] });
    observer.on('connect', () => { report.relayEvents.push({ kind: 'independent-user-socket-connected' }); save(); });
    observer.on('update', (event: any) => {
        const b = event.body;
        if ((b?.sid ?? b?.id) !== s.id) return;
        if (b.t === 'update-session' && b.metadata) {
            const m: any = decrypt(s.encryptionKey, s.encryptionVariant, decodeBase64(b.metadata.value));
            report.metadata.push({ at: new Date().toISOString(), version: b.metadata.version, currentModelCode: m?.currentModelCode, models: m?.models, claudeSessionId: m?.claudeSessionId }); save();
        }
        if (b.t === 'new-message') { report.relayEvents.push({ kind: 'message-echo', seq: b.message?.seq }); save(); }
    });
    console.log('PR1844_LOCAL_READY');
    return originalSync.call(this, s, ...args as []);
};
const originalConvert = SDKToLogConverter.prototype.convert;
SDKToLogConverter.prototype.convert = function (body: any) {
    if (body.type === 'system' && body.subtype === 'init') {
        activeInit = body;
        Object.assign(report.remote.at(-1), { initModel: body.model, sessionId: body.session_id });
    }
    const turn = report.remote.at(-1);
    if (turn && body.type === 'assistant') turn.assistants.push({ model: body.message?.model, text: body.message?.content?.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') });
    if (turn && body.type === 'result') {
        turn.result = { subtype: body.subtype, is_error: body.is_error, result: body.result, modelUsage: body.modelUsage };
        save();
        setTimeout(() => {
            if (body.is_error || body.subtype !== 'success') finish('blocked', 'Live remote inference did not succeed');
            else if (remoteSent < 2) void sendRemote().catch(e => finish('blocked', failure(e)));
            else {
                const base = expected.replace(/\[1m\]$/, '');
                const modelsAgree = report.remote.length === 2 && report.remote.every((t: any, i: number) => t.initModel?.replace(/\[1m\]$/, '') === base && t.assistants.some((a: any) => a.model?.replace(/\[1m\]$/, '') === base && a.text?.trim() === `PR1844_REMOTE_${i + 1}`));
                const last = report.metadata.at(-1);
                const sameSession = report.remote.every((t: any) => t.sessionId === report.local?.session_id);
                const published = last?.currentModelCode === expected && last?.models?.some((m: any) => m.code === expected) && last.models.length > 1;
                report.checks = { modelsAgree, sameSession, publishedCatalogAndSelection: published, explicitContextSuffix: expected.endsWith('[1m]') ? last?.currentModelCode?.endsWith('[1m]') : 'not-requested' };
                finish(modelsAgree && sameSession && published ? 'passed-headless-live-takeover' : 'failed', 'Visual app picker and actual 1M effective capacity require separate observation');
            }
        }, 1500);
    }
    save();
    return originalConvert.call(this, body);
};
setInterval(() => {
    const path = join(out, 'local-result.json');
    if (!localStarted && existsSync(path)) {
        localStarted = true;
        const local = JSON.parse(readFileSync(path, 'utf8'));
        report.local = { session_id: local.session_id, subtype: local.subtype, is_error: local.is_error, result: local.result, modelUsage: local.modelUsage }; save();
        if (report.local.is_error || report.local.subtype !== 'success') finish('blocked', 'Native local inference did not succeed');
        else setTimeout(() => void sendRemote().catch(e => finish('blocked', failure(e))), 2000);
    }
}, 300).unref();
setTimeout(() => finish('blocked', 'Live smoke timed out after 180 seconds'), 180_000).unref();
process.chdir(fixture);
try {
    await runClaude(credentials, { model: requested, startingMode: 'local', shouldStartDaemon: false,
        claudeArgs: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--tools', ''],
    });
} catch (error) { finish('blocked', failure(error)); }
if (!finished) { report.status = 'blocked'; report.reason = 'Happy exited before live takeover completed'; save(); }
