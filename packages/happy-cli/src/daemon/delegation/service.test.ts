import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvelope, DelegationRoleV1Schema, type DelegationRoleInput } from '@slopus/happy-wire';
import { createDelegationService, DelegationDeliveryError, type DelegationDependencies, type DelegationParent, type DelegationSendOptions } from './service';
import { createDelegationReporter, DELEGATION_REPORTER_ENV, parseDelegationReporterDescriptor, readDelegationReports } from './journal';
import { writeDelegationJson } from './store';

type Reporter = ReturnType<typeof createDelegationReporter>;
type Sent = { child: string; options: DelegationSendOptions; localId: string; prompt: string; reporter: Reporter };
const role: DelegationRoleInput = { id: 'writer', name: 'Writer', description: 'Write verified documentation.', agent: 'antigravity', model: 'Neon', autoDelegate: true };
const directories: string[] = [];
const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(waitTimeoutMs = 1000) {
    const directory = mkdtempSync(join(tmpdir(), 'paws-delegation-service-')); directories.push(directory);
    const parent: DelegationParent = { id: 'parent-one', agent: 'codex', directory: '/project', permissionMode: 'read-only', accountProfileId: 'private-account-reference', delegationRoutes: true };
    const alive = new Set<string>(); const reporters = new Map<string, Reporter>(); const sent: Sent[] = []; const events = new EventEmitter();
    let sendError: Error | undefined;
    let prepare: (() => Promise<void>) | undefined;
    let afterAssert: (() => Promise<void>) | undefined;
    const deps: DelegationDependencies = {
        resolveParent: vi.fn(async id => ({ ...parent, id })),
        spawn: vi.fn(async (_parent, _role, environment) => {
            const child = `child-${reporters.size + 1}`; alive.add(child);
            reporters.set(child, createDelegationReporter({ descriptor: parseDelegationReporterDescriptor(environment[DELEGATION_REPORTER_ENV])!, sessionId: child }));
            return child;
        }),
        send: vi.fn(async (child, prompt, localId, options) => {
            await prepare?.();
            await options.assertCurrent();
            await afterAssert?.();
            const reporter = reporters.get(child)!;
            if (sendError instanceof DelegationDeliveryError) throw sendError;
            expect(reporter.acceptMessage({ localId, meta: { delegation: options.delegation } })).toBe(true);
            const value = { child, options, localId, prompt, reporter }; sent.push(value); events.emit('sent', value);
            if (sendError) throw sendError;
            return { model: 'gemini-neon-actual', effort: 'high' };
        }),
        cancel: vi.fn(async () => {}), isChildAlive: child => alive.has(child), publish: vi.fn(async () => {}),
    };
    const service = await createDelegationService({ directory, deps, waitTimeoutMs }); disposers.push(service.dispose);
    await service.handle({ action: 'roles-save', parentSessionId: parent.id, role });
    return { directory, parent, alive, deps, service, reporters, sent,
        setSendError(error: Error | undefined) { sendError = error; },
        setPrepare(value: () => Promise<void>) { prepare = value; },
        setAfterAssert(value: () => Promise<void>) { afterAssert = value; },
        async nextSent(index = 0): Promise<Sent> {
            if (sent[index]) return sent[index];
            return new Promise(resolve => {
                const listener = () => { if (sent[index]) { events.off('sent', listener); resolve(sent[index]); } };
                events.on('sent', listener);
            });
        },
    };
}
function startTurn(sent: Sent) {
    const turn = `turn-${sent.options.delegation.version}`;
    sent.reporter.observe(createEnvelope('agent', { t: 'turn-start', localIds: [sent.localId] }, { turn }));
    return turn;
}
function finish(sent: Sent, text = '# Result', status: 'completed' | 'failed' | 'cancelled' = 'completed') {
    const turn = startTurn(sent);
    if (text) sent.reporter.observe(createEnvelope('agent', { t: 'text', text }, { turn }));
    sent.reporter.observe(createEnvelope('agent', { t: 'turn-end', status }, { turn }));
}
describe('persistent delegation coordinator', () => {
    it('shares machine and session CRUD with stable generated IDs and never executes a created role', async () => {
        const f = await fixture(); vi.mocked(f.deps.resolveParent).mockClear();
        const created = await f.service.handleRoles({ action: 'create', role: {
            name: role.name, description: 'A separate role with the same display name', agent: 'antigravity',
        } });
        expect(created.success).toBe(true);
        expect(created.role).toMatchObject({ name: role.name, autoDelegate: false });
        expect(created.role?.id).not.toBe(role.id);
        expect(created.role?.model).toBeUndefined();
        expect(f.deps.resolveParent).not.toHaveBeenCalled();
        expect(f.deps.spawn).not.toHaveBeenCalled(); expect(f.deps.send).not.toHaveBeenCalled();
        const id = created.role!.id;
        expect((await f.service.handleRoles({ action: 'create', role: { ...role, id } })).success).toBe(false);
        expect((await f.service.handleRoles({ action: 'update', roleId: 'missing', patch: { name: 'Do not upsert' } })).success).toBe(false);
        const updated = await f.service.handle({ action: 'roles-update', parentSessionId: f.parent.id, protocolVersion: 2, roleId: id, patch: { name: 'Updated by conversation' } });
        expect(updated.role).toMatchObject({ id, name: 'Updated by conversation', createdAt: created.role!.createdAt });
        expect((await f.service.handleRoles({ action: 'list' })).roles?.find(item => item.id === id)?.name).toBe('Updated by conversation');
        await f.service.handleRoles({ action: 'delete', roleId: id });
        expect((await f.service.handle({ action: 'roles-list', parentSessionId: f.parent.id })).roles?.map(item => item.id)).toEqual([role.id]);
        expect(JSON.parse(readFileSync(join(f.directory, 'roles.json'), 'utf8'))).toHaveLength(1);
    });

    it('clears native defaults with a patch without changing the stable role ID', async () => {
        const f = await fixture();
        await f.service.handleRoles({ action: 'update', roleId: role.id, patch: { effort: 'high' } });
        const cleared = await f.service.handleRoles({ action: 'update', roleId: role.id, patch: { model: null, effort: null } });
        expect(cleared.role?.id).toBe(role.id); expect(cleared.role?.model).toBeUndefined(); expect(cleared.role?.effort).toBeUndefined();
        expect((await f.service.handleRoles({ action: 'update', roleId: role.id, patch: { id: 'replacement' } } as any)).success).toBe(false);
    });

    it('selects the client response protocol independently from the worker execution capability', async () => {
        const f = await fixture();
        const defaults = await f.service.handleRoles({ action: 'create', role: { name: 'Native defaults', description: 'Use native defaults', agent: 'codex' } });
        // Even on a new worker, an old App must receive a fully parseable V1 list.
        const legacy = await f.service.handle({ action: 'roles-list', parentSessionId: f.parent.id });
        expect(DelegationRoleV1Schema.array().parse(legacy.roles).map(item => item.id)).toEqual([role.id]);
        f.parent.delegationRoutes = false;
        expect((await f.service.handle({ action: 'roles-list', parentSessionId: f.parent.id })).roles?.map(item => item.id)).toEqual([role.id]);
        expect((await f.service.handle({ action: 'start', parentSessionId: f.parent.id, protocolVersion: 2, requestId: 'old-default', roleId: defaults.role!.id, prompt: 'Draft' })).error).toContain('updated parent worker');
        expect((await f.service.handle({ action: 'start', parentSessionId: f.parent.id, protocolVersion: 2, requestId: 'old-route', route: { agent: 'codex' }, intent: 'explicit', prompt: 'Draft' })).success).toBe(false);
        expect(f.deps.spawn).not.toHaveBeenCalled();
        expect((await f.service.handleRoles({ action: 'list' })).roles).toHaveLength(2);
        // A new client can read/configure complete roles without native execution support.
        expect((await f.service.handle({ action: 'roles-list', parentSessionId: f.parent.id, protocolVersion: 2 })).roles).toHaveLength(2);
        expect((await f.service.handle({ action: 'roles-update', parentSessionId: f.parent.id, protocolVersion: 2,
            roleId: defaults.role!.id, patch: { name: 'Edited on old worker' } })).role?.name).toBe('Edited on old worker');
        f.parent.delegationRoutes = true;
        expect((await f.service.handle({ action: 'roles-list', parentSessionId: f.parent.id, protocolVersion: 2 })).roles).toHaveLength(2);
    });

    it('rejects V2-only execution before creating or dispatching an unrepresentable V1 task', async () => {
        const f = await fixture();
        const defaults = await f.service.handleRoles({ action: 'create', role: { name: 'Native defaults', description: 'Use native defaults', agent: 'codex' } });
        expect((await f.service.handle({ action: 'start', parentSessionId: f.parent.id, requestId: 'v1-route',
            route: { agent: 'antigravity', model: 'Neon' }, intent: 'explicit', prompt: 'Draft' })).error).toContain('protocolVersion 2');
        expect((await f.service.handle({ action: 'start', parentSessionId: f.parent.id, requestId: 'v1-default',
            roleId: defaults.role!.id, prompt: 'Draft' })).error).toContain('protocolVersion 2');
        expect(f.deps.spawn).not.toHaveBeenCalled(); expect(f.deps.send).not.toHaveBeenCalled();
        expect(readdirSync(join(f.directory, 'tasks'))).toEqual([]);
    });

    it('enforces automatic intent against the saved role policy before creating a child', async () => {
        const f = await fixture();
        await f.service.handleRoles({ action: 'update', roleId: role.id, patch: { autoDelegate: false } });
        const common = { action: 'start' as const, parentSessionId: f.parent.id, protocolVersion: 2 as const, prompt: 'Draft', intent: 'automatic' as const };
        expect((await f.service.handle({ ...common, requestId: 'auto-off', roleId: role.id })).error).toContain('Automatic delegation is disabled');
        expect((await f.service.handle({ ...common, requestId: 'auto-route', route: { agent: 'antigravity' } })).success).toBe(false);
        expect(f.deps.spawn).not.toHaveBeenCalled();
        await f.service.handleRoles({ action: 'update', roleId: role.id, patch: { autoDelegate: true } });
        const started = await f.service.handle({ ...common, requestId: 'auto-on', roleId: role.id });
        const sent = await f.nextSent(); finish(sent);
        const read = await f.service.handle({ action: 'read', parentSessionId: f.parent.id, protocolVersion: 2, taskId: started.taskId! });
        expect(read.task?.history[0].intent).toBe('automatic');
        expect((await f.service.handle({ ...common, requestId: 'auto-revise', taskId: started.taskId! })).success).toBe(false);
    });

    it('uses a temporary native-default route without saving a role and revises the same resolved worker', async () => {
        const f = await fixture();
        const started = await f.service.handle({ action: 'start', parentSessionId: f.parent.id, protocolVersion: 2, requestId: 'one-off',
            route: { agent: 'antigravity' }, intent: 'explicit', prompt: 'Draft once' });
        const first = await f.nextSent();
        expect(first.options.model).toBeUndefined(); expect(first.options.effort).toBeUndefined();
        expect((await f.service.handle({ action: 'cancel', parentSessionId: f.parent.id, taskId: started.taskId! })).error).toContain('protocolVersion 2');
        expect(f.deps.cancel).not.toHaveBeenCalled();
        finish(first, 'One-off result');
        const read = await f.service.handle({ action: 'read', parentSessionId: f.parent.id, protocolVersion: 2, taskId: started.taskId! });
        expect(read.task).toMatchObject({ model: 'gemini-neon-actual', effort: 'high' });
        expect(read.task?.roleId).toBeUndefined();
        expect((await f.service.handleRoles({ action: 'list' })).roles?.map(item => item.id)).toEqual([role.id]);
        expect((await f.service.handle({ action: 'start', parentSessionId: f.parent.id, requestId: 'v1-revision', taskId: started.taskId!, prompt: 'Old client revision' })).error).toContain('protocolVersion 2');
        expect(f.deps.send).toHaveBeenCalledTimes(1);
        const revised = await f.service.handle({ action: 'start', parentSessionId: f.parent.id, protocolVersion: 2, requestId: 'one-off-v2',
            taskId: started.taskId!, intent: 'explicit', prompt: 'Make that shorter' });
        const second = await f.nextSent(1);
        expect(second.child).toBe(first.child); expect(second.options).toMatchObject({ model: 'gemini-neon-actual', effort: 'high' });
        expect(revised.taskId).toBe(started.taskId); finish(second);
    });

    it('keeps a 200-character temporary title readable and reloadable without dispatching a retried request twice', async () => {
        const f = await fixture();
        const title = '临时任务'.repeat(50);
        const input = { action: 'start' as const, parentSessionId: f.parent.id, protocolVersion: 2 as const, requestId: 'long-temporary-title',
            title, route: { agent: 'antigravity' as const }, intent: 'explicit' as const, prompt: 'Draft once' };
        const started = await f.service.handle(input);
        expect(started.success).toBe(true); expect(started.task?.title).toBe(title); expect(started.task?.roleName.length).toBe(100);
        const sent = await f.nextSent(); finish(sent, 'Long title result');
        const result = await f.service.handle({ action: 'read', parentSessionId: f.parent.id, protocolVersion: 2, taskId: started.taskId! });
        expect(result).toMatchObject({ success: true, task: { title, roleName: title.slice(0, 100), status: 'completed' } });
        f.service.dispose();
        const reloaded = await createDelegationService({ directory: f.directory, deps: f.deps }); disposers.push(reloaded.dispose);
        const retried = await reloaded.handle(input);
        expect(retried).toMatchObject({ success: true, taskId: started.taskId, task: { title, version: 1, status: 'completed' } });
        expect(f.deps.spawn).toHaveBeenCalledTimes(1); expect(f.deps.send).toHaveBeenCalledTimes(1);
        const reread = await reloaded.handle({ action: 'read', parentSessionId: f.parent.id, protocolVersion: 2, taskId: started.taskId! });
        expect(reread.task?.result?.text).toBe('Long title result');
    });
    it('waits on a real root result, preserves model ACK and exposes only task-scoped data', async () => {
        const f = await fixture();
        const response = f.service.handle({ action: 'start', parentSessionId: f.parent.id, roleId: role.id, requestId: 'request-one', prompt: 'Write README.', context: 'Verified facts', wait: true });
        const sent = await f.nextSent(); finish(sent, '# Verified README');
        const result = await response;
        expect(result.task).toMatchObject({ status: 'completed', childSessionId: sent.child, result: { text: '# Verified README' } });
        expect(sent.options.permissionMode).toBe('read-only'); expect(sent.prompt).toContain('Verified facts');
        const read = await f.service.handle({ action: 'read', parentSessionId: f.parent.id, taskId: result.taskId! });
        expect(read.task?.model).toBe('gemini-neon-actual');
        expect((await f.service.handle({ action: 'read', parentSessionId: 'other-parent', taskId: result.taskId! })).success).toBe(false);
        const saved = readdirSync(join(f.directory, 'tasks')).map(name => readFileSync(join(f.directory, 'tasks', name), 'utf8')).join('');
        expect(saved).not.toContain('private-account-reference');
    });

    it('deduplicates concurrent retries and persists the request identity across daemon restart', async () => {
        const f = await fixture(); const input = { action: 'start' as const, parentSessionId: f.parent.id, roleId: role.id, requestId: 'request-one', prompt: 'Write README.' };
        const [one, two] = await Promise.all([f.service.handle(input), f.service.handle(input)]);
        const sent = await f.nextSent(); expect(one.taskId).toBe(two.taskId); expect(f.deps.spawn).toHaveBeenCalledTimes(1); expect(f.deps.send).toHaveBeenCalledTimes(1);
        expect((await f.service.handle({ ...input, prompt: 'Different instruction' })).success).toBe(false);
        finish(sent); await f.service.handle({ action: 'read', parentSessionId: f.parent.id, taskId: one.taskId! }); f.service.dispose();
        const restarted = await createDelegationService({ directory: f.directory, deps: f.deps }); disposers.push(restarted.dispose);
        expect((await restarted.handle(input)).task).toMatchObject({ id: one.taskId, status: 'completed', version: 1 });
        expect(f.deps.spawn).toHaveBeenCalledTimes(1); expect(f.deps.send).toHaveBeenCalledTimes(1);
    });

    it('revises the same live child and keeps historical results and its role snapshot', async () => {
        const f = await fixture();
        const first = await f.service.handle({ action: 'start', parentSessionId: f.parent.id, roleId: role.id, requestId: 'request-one', prompt: 'First draft' });
        finish(await f.nextSent(), 'Version one'); await f.service.handle({ action: 'read', parentSessionId: f.parent.id, taskId: first.taskId! });
        await f.service.handle({ action: 'roles-delete', parentSessionId: f.parent.id, roleId: role.id });
        const second = await f.service.handle({ action: 'start', parentSessionId: f.parent.id, taskId: first.taskId!, requestId: 'request-two', prompt: 'Make it shorter' });
        const next = await f.nextSent(1); expect(next.child).toBe((await f.nextSent()).child); finish(next, 'Version two');
        const result = await f.service.handle({ action: 'read', parentSessionId: f.parent.id, taskId: second.taskId! });
        expect(result.task?.history.map(item => item.result?.text)).toEqual(['Version one', 'Version two']);
        expect(f.deps.spawn).toHaveBeenCalledTimes(1);
        f.alive.clear();
        expect((await f.service.handle({ action: 'start', parentSessionId: f.parent.id, taskId: first.taskId!, requestId: 'request-three', prompt: 'Another revision' })).error).toContain('restoration is unsupported');
        expect(f.deps.spawn).toHaveBeenCalledTimes(1);
    });

    it('keeps cancellation pending until the bound child confirms cancelled', async () => {
        const f = await fixture();
        const first = await f.service.handle({ action: 'start', parentSessionId: f.parent.id, roleId: role.id, requestId: 'request-one', prompt: 'Write README.' });
        const sent = await f.nextSent(); const turn = startTurn(sent);
        const requested = await f.service.handle({ action: 'cancel', parentSessionId: f.parent.id, taskId: first.taskId! });
        expect(requested.task).toMatchObject({ status: 'running', cancelRequested: true });
        expect(f.deps.cancel).toHaveBeenCalledWith(sent.child, turn, sent.options.delegation);
        sent.reporter.observe(createEnvelope('agent', { t: 'turn-end', status: 'cancelled' }, { turn }));
        expect((await f.service.handle({ action: 'read', parentSessionId: f.parent.id, taskId: first.taskId! })).task?.status).toBe('cancelled');
    });

    it('stops input that was cancelled while the worker model was being prepared', async () => {
        const f = await fixture(); const entered = deferred<void>(); const release = deferred<void>();
        f.setPrepare(async () => { entered.resolve(); await release.promise; });
        const input = { action: 'start' as const, parentSessionId: f.parent.id, roleId: role.id, requestId: 'request-one', prompt: 'Write README.' };
        const waiting = f.service.handle({ ...input, wait: true });
        await entered.promise;
        const duplicate = await f.service.handle(input);
        await f.service.handle({ action: 'cancel', parentSessionId: f.parent.id, taskId: duplicate.taskId! });
        release.resolve();
        const result = await waiting;
        expect(result.task).toMatchObject({ status: 'cancelled', cancelRequested: true, resultAvailable: false });
        expect(f.sent).toHaveLength(0);
        expect(f.deps.cancel).toHaveBeenCalledWith('child-1', undefined, expect.objectContaining({ taskId: result.taskId, version: 1, requestId: 'request-one' }));
    });

    it('revalidates parent permissions after model preparation before input is enqueued', async () => {
        const f = await fixture(); const entered = deferred<void>(); const release = deferred<void>();
        f.setPrepare(async () => { entered.resolve(); await release.promise; });
        const waiting = f.service.handle({ action: 'start', parentSessionId: f.parent.id, roleId: role.id, requestId: 'request-one', prompt: 'Write README.', wait: true });
        await entered.promise; f.parent.permissionMode = 'default'; release.resolve();
        expect((await waiting).task).toMatchObject({ status: 'failed', error: expect.stringContaining('permissions or ownership changed') });
        expect(f.sent).toHaveLength(0);
    });

    it('accepts a binding-specific queued cancellation without inventing a root turn', async () => {
        const f = await fixture();
        const response = await f.service.handle({ action: 'start', parentSessionId: f.parent.id, roleId: role.id, requestId: 'request-one', prompt: 'Write README.' });
        const sent = await f.nextSent(); vi.mocked(f.deps.cancel).mockResolvedValueOnce({ queuedCancelled: true });
        const cancelled = await f.service.handle({ action: 'cancel', parentSessionId: f.parent.id, taskId: response.taskId! });
        expect(cancelled.task).toMatchObject({ status: 'cancelled', resultAvailable: false, cancelRequested: true });
        expect(f.deps.cancel).toHaveBeenCalledWith(sent.child, undefined, sent.options.delegation);
        expect(cancelled.task?.result).toBeUndefined();
    });

    it('returns a real waiting-for-input state without mistaking it for completion', async () => {
        const f = await fixture();
        const waiting = f.service.handle({ action: 'start', parentSessionId: f.parent.id, roleId: role.id, requestId: 'request-one', prompt: 'Write README.', wait: true });
        const sent = await f.nextSent(); const turn = startTurn(sent); sent.reporter.waitingForInput(true, turn);
        expect((await waiting).task).toMatchObject({ status: 'waiting-for-input', resultAvailable: false });
        sent.reporter.waitingForInput(false, turn); finish(sent, 'Confirmed after input');
        const result = await f.service.handle({ action: 'read', parentSessionId: f.parent.id, taskId: sent.options.delegation.taskId });
        expect(result.task).toMatchObject({ status: 'completed', result: { text: 'Confirmed after input' } });
    });

    it('returns the same task on a single wait deadline and accepts its later result without relaunch', async () => {
        const f = await fixture(20);
        const response = await f.service.handle({ action: 'start', parentSessionId: f.parent.id, roleId: role.id, requestId: 'request-one', prompt: 'Write README.', wait: true });
        expect(response.waitTimedOut).toBe(true); expect(response.task?.status).toBe('starting');
        finish(await f.nextSent(), 'Late valid result');
        const read = await f.service.handle({ action: 'read', parentSessionId: f.parent.id, taskId: response.taskId! });
        expect(read.task?.result?.text).toBe('Late valid result'); expect(f.deps.send).toHaveBeenCalledTimes(1);
    });

    it('rejects forged journal reports and does not infer success from a child session existing', async () => {
        const f = await fixture();
        const response = await f.service.handle({ action: 'start', parentSessionId: f.parent.id, roleId: role.id, requestId: 'request-one', prompt: 'Write README.' });
        await f.nextSent(); const report = readDelegationReports(join(f.directory, 'journal'))[0];
        writeDelegationJson(join(f.directory, 'journal'), `report-${report.taskId}-${report.version}.json`, { ...report, nonce: 'f'.repeat(64), status: 'completed', turnId: 'forged-root', sequence: 99, text: 'forged result' });
        const read = await f.service.handle({ action: 'read', parentSessionId: f.parent.id, taskId: response.taskId! });
        expect(read.task?.result).toBeUndefined(); expect(read.task?.status).toBe('starting');
    });

    it('keeps a model-preparation failure bound to the same child, without a silent model fallback', async () => {
        const f = await fixture(); f.setSendError(new DelegationDeliveryError('Neon is unavailable'));
        const response = await f.service.handle({ action: 'start', parentSessionId: f.parent.id, roleId: role.id, requestId: 'request-one', prompt: 'Write README.', wait: true });
        expect(response.task).toMatchObject({ status: 'failed', childSessionId: 'child-1', model: 'Neon', error: 'Neon is unavailable' });
        f.setSendError(undefined);
        const revised = await f.service.handle({ action: 'start', parentSessionId: f.parent.id, taskId: response.taskId!, requestId: 'request-two', prompt: 'Retry this task' });
        const sent = await f.nextSent(); finish(sent);
        expect(revised.task?.childSessionId).toBe('child-1'); expect(f.deps.spawn).toHaveBeenCalledTimes(1);
    });

    it('preserves an unknown delivery outcome and reconciles a late real turn without resending', async () => {
        const f = await fixture(); f.setSendError(new Error('Task message acknowledgement was lost'));
        const response = await f.service.handle({ action: 'start', parentSessionId: f.parent.id, roleId: role.id, requestId: 'request-one', prompt: 'Write README.', wait: true });
        expect(response.task?.status).toBe('interrupted');
        expect((await f.service.handle({ action: 'start', parentSessionId: f.parent.id, taskId: response.taskId!, requestId: 'request-two', prompt: 'Try again' })).success).toBe(false);
        finish(await f.nextSent());
        expect((await f.service.handle({ action: 'read', parentSessionId: f.parent.id, taskId: response.taskId! })).task?.status).toBe('completed');
        expect(f.deps.send).toHaveBeenCalledTimes(1);
    });

    it('keeps the durable native configuration when a compatible sender returns a different late result', async () => {
        const f = await fixture(); const send = vi.mocked(f.deps.send).getMockImplementation()!;
        vi.mocked(f.deps.send).mockImplementationOnce(async (...args) => {
            await args[3].persistPrepared({ model: 'gemini-neon-actual', effort: 'high' });
            await send(...args); finish(f.sent[0]);
            return { model: 'incorrect-late-result', effort: 'low' };
        });
        const response = await f.service.handle({ action: 'start', parentSessionId: f.parent.id, protocolVersion: 2,
            requestId: 'persist-before-send', route: { agent: 'antigravity' }, intent: 'explicit', prompt: 'Write README.', wait: true });
        await new Promise<void>(resolve => setImmediate(resolve));
        const read = await f.service.handle({ action: 'read', parentSessionId: f.parent.id, protocolVersion: 2, taskId: response.taskId! });
        expect(read.task).toMatchObject({ status: 'completed', model: 'gemini-neon-actual', effort: 'high' });
        expect(JSON.parse(readFileSync(join(f.directory, 'tasks', `task-${response.taskId}.json`), 'utf8')).role)
            .toMatchObject({ model: 'gemini-neon-actual', effort: 'high' });
    });

    it('rejects a late native ACK after queued cancellation without writing its configuration', async () => {
        const f = await fixture(); const entered = deferred<void>(); const release = deferred<void>(); const completed = deferred<void>();
        let lateAckError: unknown;
        vi.mocked(f.deps.cancel).mockResolvedValue({ queuedCancelled: true });
        vi.mocked(f.deps.send).mockImplementationOnce(async (_child, _prompt, _localId, options) => {
            entered.resolve(); await release.promise;
            try { await options.persistPrepared({ model: 'late-native', effort: 'high' }); }
            catch (error) { lateAckError = error; throw error; }
            finally { completed.resolve(); }
        });
        const response = await f.service.handle({ action: 'start', parentSessionId: f.parent.id, protocolVersion: 2,
            requestId: 'late-native-ack', route: { agent: 'antigravity' }, intent: 'explicit', prompt: 'Do not dispatch' });
        await entered.promise;
        const cancelled = await f.service.handle({ action: 'cancel', parentSessionId: f.parent.id, protocolVersion: 2, taskId: response.taskId! });
        expect(cancelled.task?.status).toBe('cancelled');
        release.resolve(); await completed.promise;
        expect(lateAckError).toBeInstanceOf(DelegationDeliveryError);
        expect(lateAckError).toMatchObject({ notDispatched: true, message: expect.stringContaining('cancelled before') });
        const read = await f.service.handle({ action: 'read', parentSessionId: f.parent.id, protocolVersion: 2, taskId: response.taskId! });
        expect(read.task).toMatchObject({ status: 'cancelled' });
        expect(read.task?.model).toBeUndefined();
        expect(JSON.parse(readFileSync(join(f.directory, 'tasks', `task-${response.taskId}.json`), 'utf8')).role.model).toBeUndefined();
    });

    it('rejects an old revision native ACK after a new revision starts', async () => {
        const f = await fixture();
        const first = await f.service.handle({ action: 'start', parentSessionId: f.parent.id, protocolVersion: 2,
            requestId: 'first-revision', route: { agent: 'antigravity' }, intent: 'explicit', prompt: 'Write README.' });
        const sent = await f.nextSent(); finish(sent);
        await f.service.handle({ action: 'read', parentSessionId: f.parent.id, protocolVersion: 2, taskId: first.taskId! });
        await f.service.handle({ action: 'start', parentSessionId: f.parent.id, protocolVersion: 2, requestId: 'next-revision',
            taskId: first.taskId!, intent: 'explicit', prompt: 'Shorten README.' });
        const next = await f.nextSent(1);
        await expect(sent.options.persistPrepared({ model: 'stale-native', effort: 'low' })).rejects.toMatchObject({ notDispatched: true });
        const read = await f.service.handle({ action: 'read', parentSessionId: f.parent.id, protocolVersion: 2, taskId: first.taskId! });
        expect(read.task).toMatchObject({ version: 2, model: 'gemini-neon-actual', effort: 'high' });
        expect(JSON.parse(readFileSync(join(f.directory, 'tasks', `task-${first.taskId}.json`), 'utf8')).role)
            .toMatchObject({ model: 'gemini-neon-actual', effort: 'high' });
        finish(next);
    });

    it('does not persist a native ACK after the parent permissions change during preparation', async () => {
        const f = await fixture(); const entered = deferred<void>(); const release = deferred<void>();
        const send = vi.mocked(f.deps.send).getMockImplementation()!;
        vi.mocked(f.deps.send).mockImplementationOnce(async (...args) => {
            entered.resolve(); await release.promise;
            await args[3].persistPrepared({ model: 'unauthorized-native', effort: 'high' });
            return send(...args);
        });
        const response = f.service.handle({ action: 'start', parentSessionId: f.parent.id, protocolVersion: 2,
            requestId: 'changed-parent', route: { agent: 'antigravity' }, intent: 'explicit', prompt: 'Do not dispatch', wait: true });
        await entered.promise; f.parent.permissionMode = 'default'; release.resolve();
        const result = await response;
        expect(result.task).toMatchObject({ status: 'failed', error: expect.stringContaining('permissions or ownership changed') });
        expect(result.task?.model).toBeUndefined(); expect(f.sent).toHaveLength(0);
        expect(JSON.parse(readFileSync(join(f.directory, 'tasks', `task-${result.taskId}.json`), 'utf8')).role.model).toBeUndefined();
    });

    it('rejects unsupported owners and recursive delegation before spawning', async () => {
        const f = await fixture(); const input = { action: 'start' as const, parentSessionId: f.parent.id, roleId: role.id, requestId: 'request-one', prompt: 'Write README.' };
        f.parent.delegated = true; expect((await f.service.handle(input)).error).toContain('Recursive');
        f.parent.delegated = false; f.parent.sandbox = true; expect((await f.service.handle(input)).success).toBe(false);
        f.parent.sandbox = false; f.parent.application = { id: 'bound-app' }; expect((await f.service.handle(input)).success).toBe(false);
        expect(f.deps.spawn).not.toHaveBeenCalled();
    });

    it('never treats an inspection-only authorization as permission to start or mutate roles', async () => {
        const f = await fixture(); f.parent.inspectionOnly = true;
        expect((await f.service.handle({ action: 'start', parentSessionId: f.parent.id, roleId: role.id, requestId: 'request-one', prompt: 'Write README.' })).error).toContain('Inspection authorization');
        expect((await f.service.handle({ action: 'roles-delete', parentSessionId: f.parent.id, roleId: role.id })).success).toBe(false);
        expect(f.deps.spawn).not.toHaveBeenCalled();
    });

    it('does not blindly repeat a spawn whose outcome was unknown at daemon shutdown', async () => {
        const f = await fixture(); const gate = deferred<string>(); vi.mocked(f.deps.spawn).mockImplementationOnce(() => gate.promise);
        const input = { action: 'start' as const, parentSessionId: f.parent.id, roleId: role.id, requestId: 'request-one', prompt: 'Write README.' };
        const first = await f.service.handle(input); f.service.dispose();
        const recovered = await createDelegationService({ directory: f.directory, deps: f.deps }); disposers.push(recovered.dispose);
        const result = await recovered.handle(input);
        expect(result.task).toMatchObject({ id: first.taskId, status: 'interrupted' });
        expect(f.deps.spawn).toHaveBeenCalledTimes(1); expect(f.deps.send).not.toHaveBeenCalled();
        const before = readFileSync(join(f.directory, 'tasks', `task-${first.taskId}.json`), 'utf8');
        gate.resolve('late-orphan-worker');
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(readFileSync(join(f.directory, 'tasks', `task-${first.taskId}.json`), 'utf8')).toBe(before);
        expect(f.deps.send).not.toHaveBeenCalled();
    });

    it('uses a real journal receipt to recover a running task after an unconfirmed network ACK', async () => {
        const f = await fixture(); const gate = deferred<void>();
        const send = vi.mocked(f.deps.send).getMockImplementation()!;
        vi.mocked(f.deps.send).mockImplementationOnce(async (...args) => { await send(...args); await gate.promise; });
        const response = await f.service.handle({ action: 'start', parentSessionId: f.parent.id, roleId: role.id, requestId: 'request-one', prompt: 'Write README.' });
        const sent = await f.nextSent(); startTurn(sent); f.service.dispose();
        const recovered = await createDelegationService({ directory: f.directory, deps: f.deps }); disposers.push(recovered.dispose);
        expect((await recovered.handle({ action: 'read', parentSessionId: f.parent.id, taskId: response.taskId! })).task?.status).toBe('running');
        finish(sent, 'Recovered result');
        expect((await recovered.handle({ action: 'read', parentSessionId: f.parent.id, taskId: response.taskId! })).task?.result?.text).toBe('Recovered result');
        gate.resolve();
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(f.deps.send).toHaveBeenCalledTimes(1);
    });

    it('interrupts a running task on a worker exit event and preserves a final receipt written just before exit', async () => {
        const f = await fixture();
        const waiting = f.service.handle({ action: 'start', parentSessionId: f.parent.id, roleId: role.id, requestId: 'request-one', prompt: 'Write README.', wait: true });
        const sent = await f.nextSent(); startTurn(sent); f.alive.delete(sent.child);
        await f.service.workerExited(sent.child);
        expect((await waiting).task).toMatchObject({ status: 'interrupted', error: expect.stringContaining('worker exited') });
        expect(f.deps.send).toHaveBeenCalledTimes(1);

        const g = await fixture();
        const started = await g.service.handle({ action: 'start', parentSessionId: g.parent.id, roleId: role.id, requestId: 'request-one', prompt: 'Write README.' });
        const done = await g.nextSent(); finish(done, 'Saved before exit'); g.alive.delete(done.child);
        await g.service.workerExited(done.child);
        expect((await g.service.handle({ action: 'read', parentSessionId: g.parent.id, taskId: started.taskId! })).task).toMatchObject({ status: 'completed', result: { text: 'Saved before exit' } });
    });

    it('prevents late enqueue when a worker exits during model preparation', async () => {
        const f = await fixture(); const entered = deferred<void>(); const release = deferred<void>();
        f.setPrepare(async () => { entered.resolve(); await release.promise; });
        const waiting = f.service.handle({ action: 'start', parentSessionId: f.parent.id, roleId: role.id, requestId: 'request-one', prompt: 'Write README.', wait: true });
        await entered.promise; f.alive.delete('child-1'); await f.service.workerExited('child-1'); release.resolve();
        expect((await waiting).task?.status).toBe('interrupted');
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(f.sent).toHaveLength(0);
    });

    it('republishes current persisted tasks on a reconnect after an earlier publish failed', async () => {
        const f = await fixture();
        const response = await f.service.handle({ action: 'start', parentSessionId: f.parent.id, roleId: role.id, requestId: 'request-one', prompt: 'Write README.' });
        finish(await f.nextSent(), 'Persisted result');
        await f.service.handle({ action: 'read', parentSessionId: f.parent.id, taskId: response.taskId! });
        f.service.dispose();
        vi.mocked(f.deps.publish).mockRejectedValue(new Error('Machine relay is disconnected'));
        const recovered = await createDelegationService({ directory: f.directory, deps: f.deps }); disposers.push(recovered.dispose);
        recovered.republish(); await new Promise<void>(resolve => setImmediate(resolve));
        vi.mocked(f.deps.publish).mockReset().mockResolvedValue(undefined);
        recovered.republish(); await new Promise<void>(resolve => setImmediate(resolve));
        expect(f.deps.publish).toHaveBeenCalledWith(f.parent.id, [expect.objectContaining({ id: response.taskId, status: 'completed', resultAvailable: true })], [expect.objectContaining({ id: role.id })]);
        expect(f.deps.spawn).toHaveBeenCalledTimes(1); expect(f.deps.send).toHaveBeenCalledTimes(1);
    });

    it('refreshes machine roles for known parent scopes including sessions without tasks', async () => {
        const f = await fixture();
        await f.service.handle({ action: 'roles-list', parentSessionId: 'other-parent' });
        await new Promise<void>(resolve => setImmediate(resolve));
        vi.mocked(f.deps.publish).mockClear();
        await f.service.handle({ action: 'roles-save', parentSessionId: f.parent.id, role: { ...role, name: 'Updated writer' } });
        await new Promise<void>(resolve => setImmediate(resolve));
        for (const parentId of [f.parent.id, 'other-parent']) {
            expect(f.deps.publish).toHaveBeenCalledWith(parentId, [], [expect.objectContaining({ name: 'Updated writer' })]);
        }
        vi.mocked(f.deps.publish).mockClear();
        await f.service.handle({ action: 'roles-delete', parentSessionId: f.parent.id, roleId: role.id });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(f.deps.publish).toHaveBeenCalledWith('other-parent', [], []);
        vi.mocked(f.deps.publish).mockClear();
        f.service.republish(); await new Promise<void>(resolve => setImmediate(resolve));
        expect(f.deps.publish).toHaveBeenCalledWith('other-parent', [], []);
    });

    it('fulfils cancellation that raced enqueue when the exact root appears, once per root', async () => {
        const f = await fixture(); const entered = deferred<void>(); const release = deferred<void>();
        f.setAfterAssert(async () => { entered.resolve(); await release.promise; });
        vi.mocked(f.deps.cancel).mockRejectedValueOnce(new Error('Input is not queued yet'));
        const response = await f.service.handle({ action: 'start', parentSessionId: f.parent.id, roleId: role.id, requestId: 'request-one', prompt: 'Write README.' });
        await entered.promise;
        await f.service.handle({ action: 'cancel', parentSessionId: f.parent.id, taskId: response.taskId! });
        expect(f.deps.cancel).toHaveBeenCalledTimes(1);
        release.resolve(); const sent = await f.nextSent(); const turn = startTurn(sent);
        await f.service.handle({ action: 'read', parentSessionId: f.parent.id, taskId: response.taskId! });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(f.deps.cancel).toHaveBeenCalledTimes(2);
        expect(f.deps.cancel).toHaveBeenLastCalledWith(sent.child, turn, sent.options.delegation);
        sent.reporter.observe(createEnvelope('agent', { t: 'text', text: 'Still settling cancellation' }, { turn }));
        await f.service.handle({ action: 'read', parentSessionId: f.parent.id, taskId: response.taskId! });
        expect(f.deps.cancel).toHaveBeenCalledTimes(2); expect(f.deps.send).toHaveBeenCalledTimes(1);
        sent.reporter.observe(createEnvelope('agent', { t: 'turn-end', status: 'cancelled' }, { turn }));
        expect((await f.service.handle({ action: 'read', parentSessionId: f.parent.id, taskId: response.taskId! })).task?.status).toBe('cancelled');
    });

    it('reconciles persistent cancel intent once on restart and once on an explicit reconnect event', async () => {
        const f = await fixture();
        const response = await f.service.handle({ action: 'start', parentSessionId: f.parent.id, roleId: role.id, requestId: 'request-one', prompt: 'Write README.' });
        const sent = await f.nextSent(); const turn = startTurn(sent);
        vi.mocked(f.deps.cancel).mockRejectedValue(new Error('Relay disconnected'));
        await f.service.handle({ action: 'cancel', parentSessionId: f.parent.id, taskId: response.taskId! }); f.service.dispose();
        vi.mocked(f.deps.cancel).mockClear();
        const recovered = await createDelegationService({ directory: f.directory, deps: f.deps }); disposers.push(recovered.dispose);
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(f.deps.cancel).toHaveBeenCalledTimes(1);
        vi.mocked(f.deps.cancel).mockResolvedValue(undefined); recovered.republish();
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(f.deps.cancel).toHaveBeenCalledTimes(2);
        expect(f.deps.cancel).toHaveBeenLastCalledWith(sent.child, turn, sent.options.delegation);
        await recovered.handle({ action: 'read', parentSessionId: f.parent.id, taskId: response.taskId! });
        expect(f.deps.cancel).toHaveBeenCalledTimes(2); expect(f.deps.send).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])('inspection of a fresh root receipt only fulfils existing cancel intent (%s) without awaiting native work', async cancelRequested => {
        const f = await fixture();
        const response = await f.service.handle({ action: 'start', parentSessionId: f.parent.id, roleId: role.id, requestId: 'request-one', prompt: 'Write README.' });
        const sent = await f.nextSent();
        if (cancelRequested) await f.service.handle({ action: 'cancel', parentSessionId: f.parent.id, taskId: response.taskId! });
        const priorCalls = vi.mocked(f.deps.cancel).mock.calls.length;
        const native = deferred<void>(); vi.mocked(f.deps.cancel).mockImplementation(async () => { await native.promise; });
        f.parent.inspectionOnly = true;
        const turn = startTurn(sent);
        // The authorized read can return while a prior-intent cancellation is still pending.
        const read = await f.service.handle({ action: 'read', parentSessionId: f.parent.id, taskId: response.taskId! });
        expect(read.task).toMatchObject({ status: 'running', ...(cancelRequested ? { cancelRequested: true } : {}) });
        expect(f.deps.resolveParent).toHaveBeenLastCalledWith(f.parent.id, { inspection: true });
        expect(f.deps.cancel).toHaveBeenCalledTimes(priorCalls + (cancelRequested ? 1 : 0));
        if (cancelRequested) expect(f.deps.cancel).toHaveBeenLastCalledWith(sent.child, turn, sent.options.delegation);
        native.resolve();
        sent.reporter.observe(createEnvelope('agent', { t: 'turn-end', status: cancelRequested ? 'cancelled' : 'completed' }, { turn }));
        expect((await f.service.handle({ action: 'read', parentSessionId: f.parent.id, taskId: response.taskId! })).task?.status).toBe(cancelRequested ? 'cancelled' : 'completed');
    });
});
