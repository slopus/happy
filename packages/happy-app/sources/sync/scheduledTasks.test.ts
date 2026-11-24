import { afterEach, expect, it, vi } from 'vitest';
import { createScheduledTasksController } from './scheduledTasks';

vi.mock('./serverConfig', () => ({ getServerUrl: () => 'http://localhost:3005' }));
vi.mock('./apiSocket', () => ({ getHappyClientId: () => 'test' }));
afterEach(() => vi.unstubAllGlobals());

it('loads an already visible workspace when account initialization finishes', async () => {
    const credentials = { token: 'test', secret: 'test' };
    const controller = createScheduledTasksController(() => credentials, () => undefined);
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ tasks: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    controller.setVisible(true);
    expect(fetch).not.toHaveBeenCalled();
    controller.beginAccount();
    await vi.waitFor(() => expect(controller.getSnapshot().revision).toBe(1));
    expect(fetch).toHaveBeenCalledTimes(1);
});

it('does not replace a newer history response with an older running snapshot', async () => {
    const credentials = { token: 'test', secret: 'test' };
    const controller = createScheduledTasksController(() => credentials, () => undefined);
    controller.beginAccount();
    const replies: Array<(response: Response) => void> = [];
    const run = { id: '00000000-0000-4000-8000-000000000001', taskId: '00000000-0000-4000-8000-000000000002', machineId: 'machine',
        scheduledAt: 100, createdAt: 100, updatedAt: 100, status: 'running', encryptedConfig: 'ciphertext', newChatEachRun: true,
        bindingVersion: 0, notificationPolicy: 'none', claimId: '00000000-0000-4000-8000-000000000003', sessionId: 'session', turnId: 'root',
        startedAt: 100, finishedAt: null, reason: null, missedUntil: null, deadlineAt: 86400100, conversationSessionId: null, reportSequence: 1 };
    vi.stubGlobal('fetch', () => new Promise<Response>(resolve => replies.push(resolve)));
    const first = controller.history('task');
    const second = controller.history('task');
    replies[1](new Response(JSON.stringify({ runs: [{ ...run, status: 'completed', finishedAt: 200, reportSequence: 2 }] }), { status: 200 }));
    await second;
    replies[0](new Response(JSON.stringify({ runs: [run] }), { status: 200 }));
    await first;
    expect(controller.getSnapshot().histories.task[0].status).toBe('completed');
});

const queuedRun = { id: '00000000-0000-4000-8000-000000000011', taskId: '00000000-0000-4000-8000-000000000012', machineId: 'machine',
    scheduledAt: 100, createdAt: 100, updatedAt: 100, status: 'pending', encryptedConfig: 'ciphertext', newChatEachRun: true,
    bindingVersion: 0, notificationPolicy: 'none', claimId: null, sessionId: null, turnId: null,
    startedAt: null, finishedAt: null, reason: null, missedUntil: null, deadlineAt: null, conversationSessionId: null, reportSequence: 0 };
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

it('returns the exact accepted run without waiting for the list refresh', async () => {
    const credentials = { token: 'test', secret: 'test' };
    const controller = createScheduledTasksController(() => credentials, () => undefined);
    controller.beginAccount();
    let resolveRefresh!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => init?.method === 'POST' ? Promise.resolve(json({ run: queuedRun })) : new Promise(resolve => { resolveRefresh = resolve; })));
    const run = await controller.runNow(queuedRun.taskId, '00000000-0000-4000-8000-000000000013');
    expect(run.id).toBe(queuedRun.id);
    expect(controller.getSnapshot().histories[queuedRun.taskId][0].id).toBe(queuedRun.id);
    resolveRefresh(json({ tasks: [] }));
});

it('does not let a history read started before Run now erase its newly accepted run', async () => {
    const credentials = { token: 'test', secret: 'test' };
    const controller = createScheduledTasksController(() => credentials, () => undefined);
    controller.beginAccount();
    let resolveHistory!: (response: Response) => void;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => url.endsWith('/runs') ? new Promise(resolve => { resolveHistory = resolve; }) : Promise.resolve(json(init?.method === 'POST' ? { run: queuedRun } : { tasks: [] })));
    const staleHistory = controller.history(queuedRun.taskId);
    await controller.runNow(queuedRun.taskId, '00000000-0000-4000-8000-000000000013');
    resolveHistory(json({ runs: [] })); await staleHistory;
    expect(controller.getSnapshot().histories[queuedRun.taskId][0].id).toBe(queuedRun.id);
});

it('preserves a later report even when the Run now response has the same timestamp', async () => {
    const credentials = { token: 'test', secret: 'test' };
    const controller = createScheduledTasksController(() => credentials, () => undefined);
    controller.beginAccount();
    const current = { ...queuedRun, status: 'running', reportSequence: 2, sessionId: 'exact-session', turnId: 'turn' };
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => Promise.resolve(json(url.endsWith('/runs') ? { runs: [current] } : init?.method === 'POST' ? { run: queuedRun } : { tasks: [] })));
    await controller.history(queuedRun.taskId);
    const result = await controller.runNow(queuedRun.taskId, '00000000-0000-4000-8000-000000000013');
    expect(result.sessionId).toBe('exact-session');
    expect(controller.getSnapshot().histories[queuedRun.taskId][0].status).toBe('running');
});

it('rejects a late run response after the account changes', async () => {
    let credentials = { token: 'first', secret: 'first' };
    const controller = createScheduledTasksController(() => credentials, () => undefined);
    controller.beginAccount();
    let resolveRun!: (response: Response) => void;
    vi.stubGlobal('fetch', () => new Promise(resolve => { resolveRun = resolve; }));
    const result = controller.runNow(queuedRun.taskId, '00000000-0000-4000-8000-000000000013');
    credentials = { token: 'second', secret: 'second' }; controller.beginAccount();
    resolveRun(json({ run: queuedRun }));
    await expect(result).rejects.toThrow('account-changed');
    expect(controller.getSnapshot().histories).toEqual({});
});

it('does not report save success when the account changes during its refresh', async () => {
    let credentials = { token: 'first', secret: 'first' };
    const encryption = { getMachineEncryption: () => ({ encryptRaw: async () => 'ciphertext' }) } as unknown as import('@/sync/encryption/encryption').Encryption;
    const controller = createScheduledTasksController(() => credentials, () => encryption);
    controller.beginAccount();
    let resolveRefresh!: (response: Response) => void;
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => init?.method === 'PUT' ? Promise.resolve(json({})) : new Promise(resolve => { resolveRefresh = resolve; }));
    const result = controller.save({ id: queuedRun.taskId, machineId: 'machine', rule: { type: 'daily', time: '09:00', timezone: 'UTC' }, enabled: true, newChatEachRun: true, notificationPolicy: 'none' }, { title: 'test', prompt: 'test', directory: '/tmp', agent: 'codex', permissionMode: 'read-only' }, -1);
    await vi.waitFor(() => expect(resolveRefresh).toBeDefined());
    credentials = { token: 'second', secret: 'second' }; controller.beginAccount();
    resolveRefresh(json({ tasks: [] }));
    await expect(result).rejects.toThrow('account-changed');
    expect(controller.getSnapshot().tasks).toEqual([]);
});
