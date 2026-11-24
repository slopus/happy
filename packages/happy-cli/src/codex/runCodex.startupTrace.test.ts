import { describe, expect, it, vi } from 'vitest';

import { archiveFailedCodexProcessorStartup, completeCodexProcessorStartup } from './runCodex';
import { CODEX_ACCOUNT_CONFIG_ERROR } from './codexAccountConfig';

describe('Codex processor startup trace', () => {
    it('waits for thread availability before recording and emitting processor ready', async () => {
        const order: string[] = [];
        let releaseThread!: () => void;
        const threadAvailable = new Promise<void>((resolve) => { releaseThread = resolve; });
        const session = {
            processorReady: vi.fn(() => { order.push('ready-span'); return true; }),
            sendSessionEvent: vi.fn(() => { order.push('ready-event'); }),
        };

        const reportReady = vi.fn(async () => { order.push('daemon-report'); });
        const completion = completeCodexProcessorStartup(session as any, async () => {
            order.push('thread-starting');
            await threadAvailable;
            order.push('thread-ready');
        }, reportReady);
        await Promise.resolve();
        expect(order).toEqual(['thread-starting']);

        releaseThread();
        await completion;

        expect(order).toEqual(['thread-starting', 'thread-ready', 'ready-span', 'ready-event', 'daemon-report']);
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
    });

    it('does not report a Magpie launch when preparing the thread fails', async () => {
        const session = { processorReady: vi.fn(), sendSessionEvent: vi.fn() };
        const reportReady = vi.fn();
        const failure = new Error('thread startup failed');
        await expect(completeCodexProcessorStartup(session, async () => { throw failure; }, reportReady)).rejects.toBe(failure);
        expect(session.processorReady).not.toHaveBeenCalled();
        expect(reportReady).not.toHaveBeenCalled();
    });

    it('archives a worker that exits before ready so callers have durable stop proof', async () => {
        let metadata: any = { lifecycleState: 'running', machineId: 'machine' };
        const session = {
            updateMetadataAndAwait: vi.fn(async (update: (value: any) => any) => { metadata = update(metadata); }),
            failScheduledProcessorStartup: vi.fn(async () => {
                expect(metadata.lifecycleState).toBe('archived');
            }),
            sendSessionEvent: vi.fn(),
        };

        await archiveFailedCodexProcessorStartup(session as any);

        expect(metadata).toMatchObject({
            lifecycleState: 'archived',
            archivedBy: 'cli',
            archiveReason: 'Codex processor failed before ready',
            machineId: 'machine',
        });
        expect(metadata.lifecycleStateSince).toEqual(expect.any(Number));
        expect(session.failScheduledProcessorStartup).toHaveBeenCalledOnce();
    });

    it('preserves an already archived lifecycle when startup cleanup runs again', async () => {
        const archived = { lifecycleState: 'archived', archivedBy: 'cli', lifecycleStateSince: 123, archiveReason: 'User terminated' };
        let metadata = archived;
        await archiveFailedCodexProcessorStartup({
            updateMetadataAndAwait: async (update: any) => { metadata = update(metadata); },
            failScheduledProcessorStartup: async () => {},
            sendSessionEvent: () => {},
        });
        expect(metadata).toBe(archived);
    });

    it('still persists the stopped processor receipt when its lifecycle write fails', async () => {
        const failure = new Error('offline');
        let reported = false;
        await expect(archiveFailedCodexProcessorStartup({
            updateMetadataAndAwait: async () => { throw failure; },
            failScheduledProcessorStartup: async () => { reported = true; },
            sendSessionEvent: () => {},
        })).rejects.toBe(failure);
        expect(reported).toBe(true);
    });

    it.each([CODEX_ACCOUNT_CONFIG_ERROR, 'startup failed with synthetic-secret-token'])('persists a safe visible startup error without exposing diagnostics: %s', async message => {
        const events: Array<{ type: string; message?: string }> = [];
        await archiveFailedCodexProcessorStartup({
            updateMetadataAndAwait: async () => {},
            failScheduledProcessorStartup: async () => {},
            sendSessionEvent: event => { events.push(event); },
        }, new Error(message));
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ type: 'message', message: expect.stringContaining('任务尚未开始') });
        expect(events[0].message).not.toContain('synthetic-secret-token');
        if (message === CODEX_ACCOUNT_CONFIG_ERROR) expect(events[0].message).toContain('设置 → 设备环境');
    });
});
