import { describe, expect, it, vi } from 'vitest';

import { archiveFailedCodexProcessorStartup, completeCodexProcessorStartup } from './runCodex';

describe('Codex processor startup trace', () => {
    it('waits for thread availability before recording and emitting processor ready', async () => {
        const order: string[] = [];
        let releaseThread!: () => void;
        const threadAvailable = new Promise<void>((resolve) => { releaseThread = resolve; });
        const session = {
            processorReady: vi.fn(() => { order.push('ready-span'); return true; }),
            sendSessionEvent: vi.fn(() => { order.push('ready-event'); }),
        };

        const completion = completeCodexProcessorStartup(session as any, async () => {
            order.push('thread-starting');
            await threadAvailable;
            order.push('thread-ready');
        });
        await Promise.resolve();
        expect(order).toEqual(['thread-starting']);

        releaseThread();
        await completion;

        expect(order).toEqual(['thread-starting', 'thread-ready', 'ready-span', 'ready-event']);
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
    });

    it('archives a worker that exits before ready so callers have durable stop proof', async () => {
        let metadata: any = { lifecycleState: 'running', machineId: 'machine' };
        const session = {
            updateMetadataAndAwait: vi.fn(async (update: (value: any) => any) => { metadata = update(metadata); }),
        };

        await archiveFailedCodexProcessorStartup(session as any);

        expect(metadata).toMatchObject({
            lifecycleState: 'archived',
            archivedBy: 'cli',
            archiveReason: 'Codex processor failed before ready',
            machineId: 'machine',
        });
        expect(metadata.lifecycleStateSince).toEqual(expect.any(Number));
    });

    it('preserves an already archived lifecycle when startup cleanup runs again', async () => {
        const archived = { lifecycleState: 'archived', archivedBy: 'cli', lifecycleStateSince: 123, archiveReason: 'User terminated' };
        let metadata = archived;
        await archiveFailedCodexProcessorStartup({ updateMetadataAndAwait: async (update: any) => { metadata = update(metadata); } } as any);
        expect(metadata).toBe(archived);
    });
});
