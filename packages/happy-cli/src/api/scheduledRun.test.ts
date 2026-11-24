import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createEnvelope, type ScheduledRunReport } from '@slopus/happy-wire';
import { createScheduledRunTracker } from './scheduledRun';

it('completes only the root turn that accepted the scheduled prompt, and persists a disconnected receipt', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'paws-schedule-receipt-'));
    try {
        const runId = randomUUID(), taskId = randomUUID(), claimId = randomUUID();
        let online = false; const reports: ScheduledRunReport[] = [];
        const send = async (_task: string, _run: string, report: ScheduledRunReport) => { if (!online) throw new Error('offline'); reports.push(report); };
        const tracker = createScheduledRunTracker({ directory, sessionId: 'session', send });
        tracker.acceptMessage({ localId: 'scheduled:' + runId, meta: { scheduledRun: { taskId, runId, claimId, notificationPolicy: 'none' } } });
        tracker.observe(createEnvelope('agent', { t: 'turn-start', localIds: ['other'] }, { turn: 'unrelated' }));
        tracker.observe(createEnvelope('agent', { t: 'turn-end', status: 'completed' }, { turn: 'unrelated' }));
        await tracker.flush(); expect(reports).toEqual([]);
        tracker.observe(createEnvelope('agent', { t: 'turn-start', localIds: ['scheduled:' + runId] }, { turn: 'ours' }));
        tracker.observe(createEnvelope('agent', { t: 'turn-end', status: 'completed' }, { turn: 'ours', subagent: 'child' }));
        await tracker.flush();
        online = true;
        const restored = createScheduledRunTracker({ directory, sessionId: 'session', send });
        await restored.flush(); expect(reports.at(-1)?.status).toBe('running');
        const acknowledged = reports.length;
        await restored.flush(); expect(reports).toHaveLength(acknowledged);
        restored.observe(createEnvelope('agent', { t: 'turn-start', localIds: ['scheduled:' + runId] }, { turn: 'replayed-other-root' }));
        restored.observe(createEnvelope('agent', { t: 'turn-end', status: 'completed' }, { turn: 'replayed-other-root' }));
        await restored.flush(); expect(reports.at(-1)?.status).toBe('running');
        restored.observe(createEnvelope('agent', { t: 'turn-end', status: 'completed' }, { turn: 'ours' }));
        await restored.flush();
        expect(reports.at(-1)).toMatchObject({ claimId, sessionId: 'session', turnId: 'ours', status: 'completed' });
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
