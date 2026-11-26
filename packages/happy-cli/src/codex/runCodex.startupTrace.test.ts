import { describe, expect, it, vi } from 'vitest';

import { archiveFailedCodexProcessorStartup, completeCodexProcessorStartup } from './runCodex';
import { CODEX_ACCOUNT_CONFIG_ERROR } from './codexAccountConfig';
import { createCodexDelegationPreparation, type CodexDelegationState } from './codexDelegationRpc';
import type { Model } from './codexAppServerTypes';

const nativeModel: Model = {
    id: 'native-model', model: 'native-model', displayName: 'Native model', description: '', hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '' }], defaultReasoningEffort: 'high', isDefault: true,
};
const nativeConfiguration = { models: [nativeModel], currentModel: nativeModel.model, currentEffort: 'high' as const };

describe('Codex processor startup trace', () => {
    it('keeps default-model delegation waiting until the actual startup configuration is acknowledged', async () => {
        let acknowledge!: () => void;
        const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve; });
        const state: CodexDelegationState = {
            metadata: { delegatedTask: { taskId: 'task', parentSessionId: 'parent' } }, applicationBound: false,
            thinking: false, pending: false, queueSize: 0, pendingUserInputs: false, activeRootTurnId: null, shouldExit: false,
        };
        const preparation = createCodexDelegationPreparation({ state: () => state, catalog: () => [nativeModel], apply: vi.fn(async () => {}) });
        const session = {
            getMetadata: () => state.metadata,
            updateMetadataAndAwait: vi.fn(async update => {
                await acknowledgement;
                state.metadata = update(state.metadata);
            }),
            processorReady: vi.fn(), sendSessionEvent: vi.fn(), reportDelegationReady: vi.fn(),
        };
        const startup = completeCodexProcessorStartup(session as any, async () => nativeConfiguration).then(() => {
            preparation.ready();
            session.reportDelegationReady();
        });
        const pending = preparation.prepare({ permissionMode: 'read-only' });
        void pending.catch(() => {});
        await Promise.resolve();
        await Promise.resolve();

        expect(session.updateMetadataAndAwait).toHaveBeenCalledOnce();
        expect(session.processorReady).not.toHaveBeenCalled();
        expect(session.sendSessionEvent).not.toHaveBeenCalled();
        expect(session.reportDelegationReady).not.toHaveBeenCalled();

        acknowledge();
        await startup;
        await expect(pending).resolves.toEqual({ model: 'native-model', effort: 'high' });
        expect(session.reportDelegationReady).toHaveBeenCalledOnce();
    });

    it('does not announce readiness when the startup configuration cannot be acknowledged', async () => {
        const failure = new Error('metadata acknowledgement failed');
        const session = {
            updateMetadataAndAwait: vi.fn(async () => { throw failure; }),
            processorReady: vi.fn(), sendSessionEvent: vi.fn(),
        };
        const reportReady = vi.fn();
        await expect(completeCodexProcessorStartup(session as any, async () => nativeConfiguration, reportReady)).rejects.toBe(failure);
        expect(session.processorReady).not.toHaveBeenCalled();
        expect(session.sendSessionEvent).not.toHaveBeenCalled();
        expect(reportReady).not.toHaveBeenCalled();
    });

    it.each(['missing', 'different-model', 'different-effort'])('does not announce readiness after a resolved metadata write with %s settings', async mismatch => {
        const session = {
            updateMetadataAndAwait: vi.fn(async update => { update({}); }),
            getMetadata: () => mismatch === 'missing' ? null : ({
                currentModelCode: mismatch === 'different-model' ? 'other-model' : 'native-model',
                currentThoughtLevelCode: mismatch === 'different-effort' ? 'medium' : 'high',
            }),
            processorReady: vi.fn(), sendSessionEvent: vi.fn(),
        };
        const reportReady = vi.fn();
        await expect(completeCodexProcessorStartup(session as any, async () => nativeConfiguration, reportReady)).rejects.toThrow('startup configuration was not acknowledged');
        expect(session.processorReady).not.toHaveBeenCalled();
        expect(session.sendSessionEvent).not.toHaveBeenCalled();
        expect(reportReady).not.toHaveBeenCalled();
    });

    it('waits for thread availability before recording and emitting processor ready', async () => {
        const order: string[] = [];
        let releaseThread!: () => void;
        const threadAvailable = new Promise<void>((resolve) => { releaseThread = resolve; });
        const session = {
            getMetadata: () => ({ currentModelCode: 'native-model', currentThoughtLevelCode: 'high' }),
            updateMetadataAndAwait: vi.fn(async update => { update({}); order.push('configuration-ack'); }),
            processorReady: vi.fn(() => { order.push('ready-span'); return true; }),
            sendSessionEvent: vi.fn(() => { order.push('ready-event'); }),
        };

        const reportReady = vi.fn(async () => { order.push('daemon-report'); });
        const completion = completeCodexProcessorStartup(session as any, async () => {
            order.push('thread-starting');
            await threadAvailable;
            order.push('thread-ready');
            return nativeConfiguration;
        }, reportReady);
        await Promise.resolve();
        expect(order).toEqual(['thread-starting']);

        releaseThread();
        await completion;

        expect(order).toEqual(['thread-starting', 'thread-ready', 'configuration-ack', 'ready-span', 'ready-event', 'daemon-report']);
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
    });

    it('does not report a Magpie launch when preparing the thread fails', async () => {
        const session = { getMetadata: vi.fn(), updateMetadataAndAwait: vi.fn(), processorReady: vi.fn(), sendSessionEvent: vi.fn() };
        const reportReady = vi.fn();
        const failure = new Error('thread startup failed');
        await expect(completeCodexProcessorStartup(session, async () => { throw failure; }, reportReady)).rejects.toBe(failure);
        expect(session.processorReady).not.toHaveBeenCalled();
        expect(session.updateMetadataAndAwait).not.toHaveBeenCalled();
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
