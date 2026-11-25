/**
 * Opt-in real-executor acceptance through the encrypted machine/session RPCs.
 * Defaults to a dry run: no credentials, network, daemon, or workers are opened.
 * Run with `pnpm exec tsx scripts/delegation-real-e2e.mjs --run ...` from happy-cli.
 * Add --native-parent true to require both real parent models to call the MCP tools.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { parseHarnessOwnerCredentials, resolveHarnessMachineEncryption, resolveHarnessSessionEncryption } from './delegation-real-e2e-credentials.mjs';
import { parseHarnessArguments, createNativeParentProof, buildNativeParentPrompt } from './delegation-real-e2e-protocol.mjs';
import { createEventDrivenMessageReplay } from './delegation-real-e2e-replay.mjs';

async function main() {
const cases = ['Codex -> Antigravity', 'Antigravity -> Codex'];
const required = ['server', 'machine', 'credentials', 'project', 'codex-model', 'agy-model', 'output'];
const args = parseHarnessArguments(process.argv.slice(2));
const nativeParentRequested = args.get('native-parent') === true;
if (!args.get('run')) {
    const plan = JSON.stringify({ mode: 'dry-run', connects: false, startsWorkers: false, nativeParentRequested, requiredArguments: required,
        dataKeyOnlyArguments: ['retained-sessions (absolute path to the selected daemon’s existing sessions.json)'],
        cases, checks: ['actual native model code', 'encrypted result return', 'same task revision reuses child', 'confirmed cancellation', 'revision after cancellation', 'parent metadata publication'],
        ...(nativeParentRequested ? { nativeParentChecks: ['real agent_roles(list) and delegate_task calls in the submitted parent root', 'new child task completed with unique result marker', 'parent final markers and completed root'] } : {}),
        scope: 'New dedicated parents and their children only; no existing chat history is read.',
        command: `pnpm exec tsx scripts/delegation-real-e2e.mjs --run${nativeParentRequested ? ' --native-parent true' : ''} --server <origin> --machine <id> --credentials <private-owner-or-cli-json> --retained-sessions <absolute-existing-daemon-sessions.json> --project <dedicated-existing-project> --codex-model <code> --agy-model <code-or-unambiguous-label> --output <private-report.json>` }, null, 2);
    await new Promise((resolve, reject) => process.stdout.write(plan + '\n', error => error ? reject(error) : resolve()));
    return;
}
for (const key of required) assert(typeof args.get(key) === 'string', `Required: --${key}`);
const server = new URL(args.get('server')).origin;
const machineId = args.get('machine');
const project = await fs.realpath(args.get('project'));
assert((await fs.stat(project)).isDirectory(), 'The dedicated synthetic project must already exist');
const credentialPath = await fs.realpath(args.get('credentials'));
const outputPath = path.resolve(args.get('output'));
assert.notEqual(outputPath, credentialPath, 'Evidence output must not replace owner credentials');
let retainedPath;
if (args.has('retained-sessions')) {
    assert(path.isAbsolute(args.get('retained-sessions')), '--retained-sessions must be an explicit absolute path');
    retainedPath = await fs.realpath(args.get('retained-sessions'));
    assert((await fs.stat(retainedPath)).isFile(), 'Retained sessions must be an existing file');
    assert.notEqual(outputPath, retainedPath, 'Evidence output must not replace retained sessions');
}
await fs.access(path.dirname(outputPath));
try { await fs.lstat(outputPath); assert.fail('Evidence output must be a new file'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
assert(((await fs.stat(credentialPath)).mode & 0o077) === 0, 'Owner credential file must be private (0600)');
async function privateJson(file, label) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch { throw new Error(`Could not read ${label} JSON`); }
}
const rawCredentials = await privateJson(credentialPath, 'private credentials');
const crypto = await import('../../paws-agent/src/crypto/encryption.ts');
const { resolveRecordEncryption } = await import('../../paws-agent/src/crypto/records.ts');
const { resolveDelegationModel } = await import('../src/daemon/delegationModel.ts');
const { io } = await import('socket.io-client');
const owner = parseHarnessOwnerCredentials(rawCredentials, crypto.deriveContentKeyPair);
assert(owner.mode !== 'dataKey-only' || retainedPath, 'CLI dataKey credentials require --retained-sessions with an absolute existing daemon sessions.json path');
const credentials = owner.credentials;
delete rawCredentials.token;
delete rawCredentials.secret;
delete rawCredentials.encryption;
const runId = randomUUID();
const knownSessions = new Set();
const parentSessionIds = new Set();
const nativeParentReplays = new Map();
const records = new Map();
const earlyMetadata = new Map();
const changes = new EventEmitter();
let connectionFailure;
const evidence = { runId, startedAt: new Date().toISOString(), server, machineId, project, nativeParentRequested,
    parentModelInvokedMcp: false, nativeParentCoverageComplete: false, nativeParentCases: [], cases: [], createdSessionIds: [] };

async function http(endpoint) {
    const response = await fetch(new URL(endpoint, server), { headers: { Authorization: `Bearer ${credentials.token}` }, signal: AbortSignal.timeout(30_000) });
    assert(response.ok, `Single scoped HTTP request failed: ${response.status}`);
    return response.json();
}
function decrypt(encryption, value) {
    const plain = crypto.decrypt(encryption.key, encryption.variant, crypto.decodeBase64(value));
    assert(plain !== null, 'Encrypted scoped response could not be verified');
    return plain;
}
async function loadCreatedSession(id) {
    assert(knownSessions.has(id), 'Refusing to read a session outside this run');
    const { session } = await http(`/v2/sessions/${encodeURIComponent(id)}`);
    assert.equal(session.id, id);
    const encryption = await resolveHarnessSessionEncryption(session, { owner, knownSessions, resolveRecordEncryption,
        readRetained: retainedPath ? () => privateJson(retainedPath, 'retained sessions') : undefined });
    const record = { encryption, metadata: decrypt(encryption, session.metadata), version: session.metadataVersion };
    const buffered = earlyMetadata.get(id);
    if (buffered?.version > record.version) { record.metadata = decrypt(encryption, buffered.value); record.version = buffered.version; }
    earlyMetadata.delete(id);
    records.set(id, record);
    changes.emit('change');
    return record;
}
const { machine } = await http(`/v1/machines/${encodeURIComponent(machineId)}`);
assert.equal(machine.id, machineId);
assert(machine.active, 'The explicitly selected daemon must already be online');
const machineEncryption = resolveHarnessMachineEncryption(machine, owner, resolveRecordEncryption);
const machineMetadata = decrypt(machineEncryption, machine.metadata);
assert.equal(machineMetadata.delegation, 1, 'Selected daemon has not advertised delegation support');
const socket = io(server, { path: '/v1/updates', transports: ['websocket'], reconnection: false,
    auth: { token: credentials.token, clientType: 'user-scoped' } });
socket.on('update', event => {
    const body = event?.body;
    if (body?.t === 'new-message') {
        // Never decrypt another session's chat, including unrelated children.
        const replay = parentSessionIds.has(body.sid) ? nativeParentReplays.get(body.sid) : undefined;
        if (replay) void replay.notify(body.sid, body.message);
        return;
    }
    if (body?.t !== 'update-session' || !knownSessions.has(body.id) || !body.metadata?.value) return;
    try {
        const record = records.get(body.id);
        if (!record) {
            if ((earlyMetadata.get(body.id)?.version ?? -1) < body.metadata.version) earlyMetadata.set(body.id, body.metadata);
        } else if (body.metadata.version > record.version) {
            record.metadata = decrypt(record.encryption, body.metadata.value);
            record.version = body.metadata.version;
        }
        changes.emit('change');
    } catch { connectionFailure = new Error('Could not verify a scoped metadata event'); changes.emit('change'); }
});
socket.on('disconnect', () => { connectionFailure = new Error('Acceptance socket disconnected; no polling fallback'); changes.emit('change'); });
function eventWait(check, label, timeout = 180_000) {
    return new Promise((resolve, reject) => {
        const finish = (error, value) => { clearTimeout(timer); changes.off('change', inspect); error ? reject(error) : resolve(value); };
        const inspect = () => {
            try { if (connectionFailure) throw connectionFailure; const value = check(); if (value) finish(undefined, value); }
            catch (error) { finish(error); }
        };
        const timer = setTimeout(() => finish(new Error(`One event wait timed out: ${label}`)), timeout);
        changes.on('change', inspect);
        inspect();
    });
}
async function rpc(id, encryption, method, input, timeout = 100_000) {
    const result = await socket.timeout(timeout).emitWithAck('rpc-call', { method: `${id}:${method}`,
        params: crypto.encodeBase64(crypto.encrypt(encryption.key, encryption.variant, input)) });
    assert(result.ok && typeof result.result === 'string', `Encrypted RPC failed: ${method}`);
    return decrypt(encryption, result.result);
}
const machineRpc = (method, input) => rpc(machineId, machineEncryption, method, input);
async function delegation(parentId, input) {
    const result = await machineRpc('delegation', { ...input, parentSessionId: parentId });
    assert(result.success, `Delegation action failed: ${input.action}`);
    return result;
}
function waitTask(parentId, taskId, version, desired) {
    return eventWait(() => {
        const summary = records.get(parentId)?.metadata.delegatedTasks?.find(task => task.id === taskId && task.version === version);
        if (!summary) return;
        if (desired.includes(summary.status)) return summary;
        assert(!['failed', 'interrupted', 'waiting-for-input', 'completed', 'cancelled'].includes(summary.status), `Unexpected task lifecycle: ${summary.status}`);
    }, `${taskId} revision ${version}: ${desired.join('/')}`);
}
async function spawnParent(agent) {
    let codexSessionGrant;
    if (agent === 'codex') {
        // Match the SDK's one-shot launch authorization. Only an explicitly
        // unbound account may use the daemon's existing native login.
        const response = await fetch(new URL('/v1/codex-session-grants', server), { method: 'POST',
            headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ machineId }), signal: AbortSignal.timeout(30_000) });
        const value = await response.json();
        if (!(response.status === 409 && value.error === 'codex-account-unbound')) {
            assert(response.ok && typeof value.grant === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.grant), 'Scoped Codex launch grant was unavailable');
            codexSessionGrant = value.grant;
        }
    }
    const result = await machineRpc('spawn-happy-session', { directory: project, approvedNewDirectoryCreation: false, agent,
        ...(codexSessionGrant ? { codexSessionGrant } : {}),
        ...(agent === 'codex' ? { model: args.get('codex-model'), ...(args.get('codex-effort') ? { effort: args.get('codex-effort') } : {}) } : {}) });
    assert.equal(result.type, 'success', `Could not start the dedicated ${agent} parent`);
    const id = result.sessionId;
    assert(typeof id === 'string' && !knownSessions.has(id), 'Expected a fresh, unique parent session');
    knownSessions.add(id);
    parentSessionIds.add(id);
    evidence.createdSessionIds.push(id);
    const record = await loadCreatedSession(id);
    assert.equal(record.metadata.machineId, machineId);
    assert.equal(record.metadata.flavor, agent);
    assert.equal(record.metadata.path, project);
    assert(!record.metadata.delegatedTask, 'A harness parent must not itself be delegated');
    // Parents use their public configuration controls. The prepare RPC is
    // deliberately restricted to delegated children on the Codex runtime.
    await eventWait(() => records.get(id)?.metadata.models?.length, `${agent} native model catalog`);
    const selected = resolveDelegationModel(args.get(agent === 'codex' ? 'codex-model' : 'agy-model'),
        records.get(id).metadata.models.map(option => ({ code: option.code, name: option.value })));
    let actual;
    if (agent === 'antigravity') {
        const config = await rpc(id, record.encryption, 'setAcpConfig', { model: selected.code,
            ...(args.get('agy-effort') ? { effort: args.get('agy-effort') } : {}) });
        const model = config.configOptions?.find(option => option.category === 'model');
        const effort = config.configOptions?.find(option => option.category === 'thought_level');
        assert.equal(model?.currentValue, selected.code, 'Native Antigravity configuration was not acknowledged');
        actual = { model: model.currentValue, ...(effort?.currentValue ? { effort: effort.currentValue } : {}) };
    } else {
        await eventWait(() => records.get(id)?.metadata.currentModelCode === selected.code, 'Codex native configured model');
        actual = { model: selected.code, ...(records.get(id).metadata.currentThoughtLevelCode ? { effort: records.get(id).metadata.currentThoughtLevelCode } : {}) };
    }
    const mode = agent === 'codex' ? 'yolo' : 'bypassPermissions';
    assert.equal(await rpc(id, record.encryption, 'setPermissionMode', { mode }), true);
    assert.equal((await rpc(id, record.encryption, 'delegation-context', {})).permissionMode, mode, 'Parent full-access policy was not acknowledged');
    assert(typeof actual.model === 'string' && actual.model.length, 'Native model code was not acknowledged');
    return { id, agent, actual };
}
async function runDirection(parent, target) {
    const marker = `DELEGATION_E2E_${runId}_${parent.agent}`;
    const roleId = `e2e-${runId}-${target.agent}`;
    await delegation(parent.id, { action: 'roles-save', role: { id: roleId, name: `E2E ${target.agent}`, description: 'Synthetic acceptance only. Reply with the requested marker and do not edit files.',
        agent: target.agent, model: target.actual.model, ...(target.actual.effort ? { effort: target.actual.effort } : {}), autoDelegate: false } });
    const start = await delegation(parent.id, { action: 'start', requestId: `${runId}-${parent.agent}-1`, roleId, prompt: `Reply exactly ${marker}_V1. Do not use tools or modify files.`, wait: false });
    const taskId = start.taskId ?? start.task?.id;
    assert(taskId, 'Start did not return a task identity');
    const first = await waitTask(parent.id, taskId, 1, ['completed']);
    assert(first.childSessionId && !knownSessions.has(first.childSessionId), 'Expected a new independent delegated worker');
    knownSessions.add(first.childSessionId);
    evidence.createdSessionIds.push(first.childSessionId);
    const child = await loadCreatedSession(first.childSessionId);
    assert.equal(child.metadata.parentSessionId, parent.id);
    assert.equal(child.metadata.delegatedTask?.taskId, taskId);
    assert.equal(child.metadata.flavor, target.agent);
    assert.equal(first.model, target.actual.model, 'Task did not preserve the acknowledged native model code');
    assert.equal(child.metadata.currentModelCode, first.model, 'Native worker metadata disagrees with the actual model code');
    const firstRead = (await delegation(parent.id, { action: 'read', taskId })).task;
    assert(firstRead.result?.text.includes(`${marker}_V1`), 'Encrypted task result was not returned');
    await delegation(parent.id, { action: 'start', requestId: `${runId}-${parent.agent}-2`, taskId, prompt: `Revise this same task: reply exactly ${marker}_V2. Do not use tools or modify files.`, wait: false });
    const second = await waitTask(parent.id, taskId, 2, ['completed']);
    assert.equal(second.childSessionId, first.childSessionId, 'Revision spawned a different worker');
    const secondRead = (await delegation(parent.id, { action: 'read', taskId })).task;
    assert(secondRead.result?.text.includes(`${marker}_V2`));
    assert(secondRead.history.find(version => version.version === 1)?.result?.text.includes(`${marker}_V1`), 'Prior revision result was lost');
    await delegation(parent.id, { action: 'start', requestId: `${runId}-${parent.agent}-3`, taskId,
        prompt: `Cancellation acceptance: run one terminal command node -e "setTimeout(() => console.log('WAIT_COMPLETE'), 45000)" and only after it finishes reply ${marker}_V3. Do not edit files or access external services.`, wait: false });
    await waitTask(parent.id, taskId, 3, ['running']);
    await delegation(parent.id, { action: 'cancel', taskId });
    const cancelled = await waitTask(parent.id, taskId, 3, ['cancelled']);
    assert.equal(cancelled.childSessionId, first.childSessionId);
    await delegation(parent.id, { action: 'start', requestId: `${runId}-${parent.agent}-4`, taskId, prompt: `After cancellation, revise this same task: reply exactly ${marker}_V4. Do not use tools or modify files.`, wait: false });
    const fourth = await waitTask(parent.id, taskId, 4, ['completed']);
    assert.equal(fourth.childSessionId, first.childSessionId, 'Cancellation made the worker unusable for a revision');
    const readback = (await delegation(parent.id, { action: 'read', taskId })).task;
    assert(readback.result?.text.includes(`${marker}_V4`));
    assert.equal(readback.history.find(version => version.version === 3)?.status, 'cancelled');
    evidence.cases.push({ parent: parent.agent, executor: target.agent, parentSessionId: parent.id, childSessionId: first.childSessionId,
        taskId, actualModelCode: first.model, actualEffort: first.effort, revisions: readback.history.map(version => ({ version: version.version, status: version.status })),
        resultReturned: true, parentMetadataPublished: true, sameChildAcrossRevisions: true, cancellationConfirmed: true });
    return { roleId };
}
async function runNativeParentDirection(parent, target, roleId) {
    assert(parentSessionIds.has(parent.id), 'Native-parent checks require a parent created by this run');
    const localId = `native-parent:${runId}:${parent.agent}`;
    const requestId = `native-${runId}-${parent.agent}`;
    const childMarker = `MCP_CHILD_${runId}_${parent.agent}`;
    const parentMarker = `MCP_PARENT_${runId}_${parent.agent}`;
    const record = records.get(parent.id);
    const proof = createNativeParentProof({ parentSessionId: parent.id, localId, roleId, requestId, childMarker, parentMarker,
        previousTaskIds: record.metadata.delegatedTasks?.map(task => task.id) ?? [] });
    const replay = createEventDrivenMessageReplay({
        sessionId: parent.id,
        readPage: ({ sessionId, afterSeq, limit }) => http(`/v3/sessions/${encodeURIComponent(sessionId)}/messages?after_seq=${afterSeq}&limit=${limit}`),
        onMessage: message => {
            assert(message.content?.t === 'encrypted' && typeof message.content.c === 'string', 'The scoped durable message is not encrypted');
            proof.observe(decrypt(record.encryption, message.content.c));
            changes.emit('change');
        },
        onError: error => {
            connectionFailure = error instanceof assert.AssertionError ? error : new Error('Could not verify the event-triggered durable native-parent protocol');
            changes.emit('change');
        },
    });
    nativeParentReplays.set(parent.id, replay);
    try {
        const content = crypto.encodeBase64(crypto.encrypt(record.encryption.key, record.encryption.variant, {
            role: 'user', content: { type: 'text', text: buildNativeParentPrompt({ roleId, requestId, childMarker, parentMarker }) },
            meta: { sentFrom: 'paws-delegation-e2e', permissionMode: parent.agent === 'codex' ? 'yolo' : 'bypassPermissions',
                permissionModeExplicit: true, model: parent.actual.model, ...(parent.actual.effort ? { effort: parent.actual.effort } : {}) },
        }));
        const sent = await fetch(new URL(`/v3/sessions/${encodeURIComponent(parent.id)}/messages`, server), { method: 'POST',
            headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: [{ localId, content }] }), signal: AbortSignal.timeout(30_000) });
        assert(sent.ok, 'The one scoped native-parent prompt delivery failed');
        const verified = await eventWait(() => proof.completed(records.get(parent.id)?.metadata.delegatedTasks),
            `${parent.agent} native parent tools, independent child result, and completed root`, 10 * 60_000 + 30_000);
        const task = verified.task;
        assert.equal(task.agent, target.agent, 'Native parent selected a different executor');
        assert.equal(task.model, target.actual.model, 'Native parent selected a different native model');
        assert(!knownSessions.has(task.childSessionId), 'Native parent did not create a new independent child task');
        knownSessions.add(task.childSessionId);
        evidence.createdSessionIds.push(task.childSessionId);
        const child = await loadCreatedSession(task.childSessionId);
        assert.equal(child.metadata.parentSessionId, parent.id);
        assert.equal(child.metadata.delegatedTask?.taskId, task.id);
        assert.equal(child.metadata.flavor, target.agent);
        assert.equal(child.metadata.currentModelCode, task.model, 'Native child model metadata disagrees with its task');
        const readback = (await delegation(parent.id, { action: 'read', taskId: task.id })).task;
        assert.equal(readback.status, 'completed');
        assert(readback.result?.text.includes(childMarker), 'The actual native child result lacks its unique marker');
        evidence.nativeParentCases.push({ parent: parent.agent, executor: target.agent, parentSessionId: parent.id, childSessionId: task.childSessionId,
            taskId: task.id, rootTurnId: verified.rootTurnId, actualModelCode: task.model, toolCalls: verified.toolCalls,
            parentFinalMarkersVerified: true, childResultMarkerVerified: true, parentRootCompleted: true, childTaskCompleted: true });
        evidence.parentModelInvokedMcp = true;
    } finally { replay.stop(); nativeParentReplays.delete(parent.id); }
}
try {
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('One socket connection attempt timed out')), 15_000);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('connect_error', () => { clearTimeout(timer); reject(new Error('Encrypted account connection failed')); });
    });
    const codex = await spawnParent('codex');
    const agy = await spawnParent('antigravity');
    const codexToAgy = await runDirection(codex, agy);
    const agyToCodex = await runDirection(agy, codex);
    if (nativeParentRequested) {
        await runNativeParentDirection(codex, agy, codexToAgy.roleId);
        await runNativeParentDirection(agy, codex, agyToCodex.roleId);
        evidence.nativeParentCoverageComplete = true;
    }
    evidence.status = 'passed';
} catch (error) {
    evidence.status = 'failed';
    // Do not serialize upstream provider errors, user messages, credentials, or keys.
    evidence.failure = error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'A scoped transport/event operation failed; inspect the dedicated test sessions.';
    process.exitCode = 1;
} finally {
    socket.disconnect();
    evidence.finishedAt = new Date().toISOString();
    await fs.writeFile(outputPath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ status: evidence.status, report: outputPath, createdSessionIds: evidence.createdSessionIds,
        caseCount: evidence.cases.length, nativeParentCaseCount: evidence.nativeParentCases.length }));
    // Keep dedicated sessions and role/task evidence reviewable. No daemon change,
    // cleanup RPC, old-session read, or automatic replacement worker is performed.
}
}

try { await main(); }
catch {
    // Credential JSON parsing, filesystem errors and provider failures may carry
    // private snippets or structured values. Never print their messages/stacks.
    console.error('Scoped delegation acceptance could not initialize or save evidence; check explicit arguments, private credentials and retained-session access.');
    process.exitCode = 1;
}
