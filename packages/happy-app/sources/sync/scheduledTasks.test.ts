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
