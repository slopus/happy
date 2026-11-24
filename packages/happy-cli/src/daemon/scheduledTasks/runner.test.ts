import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ScheduledRun, ScheduledRunReport, ScheduledRunClaim } from '@slopus/happy-wire';
import { createScheduleJournal, type ScheduledSessionBinding } from './journal';
import { createScheduledTaskRunner } from './runner';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'paws-schedule-')); directories.push(path); return path; };
const run = (): ScheduledRunClaim => ({ id: randomUUID(), taskId: randomUUID(), machineId: 'machine', scheduledAt: 100, createdAt: 100, updatedAt: 100,
    status: 'claimed', encryptedConfig: 'ciphertext', newChatEachRun: false, bindingVersion: 0, notificationPolicy: 'important',
    claimId: randomUUID(), sessionId: null, turnId: null, startedAt: null, finishedAt: null, reason: null, missedUntil: null, deadlineAt: 86400100,
    conversationSessionId: null, reportSequence: 0, deliveryAuthorized: true });
const binding: ScheduledSessionBinding = { sessionId: 'session', agent: 'codex', directory: '/work', saved: {
    encryptionKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', encryptionVariant: 'dataKey', seq: 0, metadataVersion: 1, agentStateVersion: 0,
    savedAt: 100, metadata: { path: '/work', host: 'machine', machineId: 'machine', homeDir: '/home', happyHomeDir: '/home/.happy', happyLibDir: '/lib', happyToolsDir: '/tools' },
} };

it('does not launch or redeliver after a restart in the uncertain send window', async () => {
    const journal = createScheduleJournal(directory());
    const item = run(); let starts = 0, sends = 0;
    const reports: ScheduledRunReport[] = [];
    const deps = { journal, decrypt: () => ({ title: 'Task', prompt: 'Reply once', directory: '/work', agent: 'codex', permissionMode: 'read-only' }),
        claim: async () => [item], start: async () => { starts++; return binding; },
        send: async () => { sends++; throw new Error('connection lost after sending'); },
        report: async (_run: ScheduledRun, report: ScheduledRunReport) => { reports.push(report); } };
    await createScheduledTaskRunner(deps).wake();
    await createScheduledTaskRunner({ ...deps, journal: createScheduleJournal(journal.directory) }).wake();
    expect(starts).toBe(1); expect(sends).toBe(1);
    expect(reports.at(-1)?.status).toBe('uncertain');
    expect(statSync(join(journal.directory, 'run-' + item.id + '.json')).mode & 0o777).toBe(0o600);
});

it('does not authorize a second process to launch an already claimed run without its journal', async () => {
    const item = { ...run(), deliveryAuthorized: false }; let starts = 0;
    const reports: ScheduledRunReport[] = [];
    const runner = createScheduledTaskRunner({ journal: createScheduleJournal(directory()), decrypt: () => ({ title: 'Task', prompt: 'Go', directory: '/work', agent: 'codex' }),
        claim: async () => [item], start: async () => { starts++; return binding; }, send: async () => {},
        report: async (_run, report) => { reports.push(report); } });
    await runner.wake(); expect(starts).toBe(0); expect(reports).toEqual([]);
});

it('does not mark another live claimant uncertain while sharing its starting journal', async () => {
    const journal = createScheduleJournal(directory());
    const item = { ...run(), deliveryAuthorized: false };
    journal.writeRun({ runId: item.id, taskId: item.taskId, phase: 'starting' });
    const reports: ScheduledRunReport[] = [];
    const runner = createScheduledTaskRunner({ journal, decrypt: () => ({}), claim: async () => [item],
        start: async () => { throw new Error('must not launch'); }, send: async () => {}, report: async (_run, report) => { reports.push(report); } });
    await runner.wake(); expect(reports).toEqual([]);
});

it('does not silently replace a fixed conversation when its local binding is missing', async () => {
    const item = { ...run(), conversationSessionId: 'previous-session', deliveryAuthorized: true }; let starts = 0;
    const reports: ScheduledRunReport[] = [];
    const runner = createScheduledTaskRunner({ journal: createScheduleJournal(directory()), decrypt: () => ({ title: 'Task', prompt: 'Go', directory: '/work', agent: 'codex' }),
        claim: async () => [item], start: async () => { starts++; return binding; }, send: async () => {},
        report: async (_run, report) => { reports.push(report); } });
    await runner.wake(); expect(starts).toBe(0); expect(reports[0].status).toBe('uncertain');
});

it('keeps a task conversation binding across restarts and uses a stable prompt id', async () => {
    const journal = createScheduleJournal(directory()); const first = run();
    const second = { ...run(), taskId: first.taskId };
    const startedWith: Array<ScheduledSessionBinding | null> = [];
    const sent: string[] = [];
    const deps = { journal, decrypt: () => ({ title: 'Task', prompt: 'Reply once', directory: '/work', agent: 'codex', permissionMode: 'read-only' }),
        claim: async () => [first], start: async (_config: unknown, saved: ScheduledSessionBinding | null) => { startedWith.push(saved); return binding; },
        send: async (_binding: ScheduledSessionBinding, item: ScheduledRun) => { sent.push('scheduled:' + item.id); },
        report: async () => {} };
    await createScheduledTaskRunner(deps).wake();
    await createScheduledTaskRunner({ ...deps, journal: createScheduleJournal(journal.directory), claim: async () => [second] }).wake();
    expect(startedWith).toEqual([null, binding]);
    expect(sent).toEqual(['scheduled:' + first.id, 'scheduled:' + second.id]);
});

it('coalesces simultaneous wake events instead of claiming and launching twice', async () => {
    const journal = createScheduleJournal(directory()); const item = run(); let starts = 0;
    const runner = createScheduledTaskRunner({ journal, decrypt: () => ({ title: 'Task', prompt: 'Go', directory: '/work', agent: 'codex' }),
        claim: async () => [item], start: async () => { starts++; return binding; }, send: async () => {}, report: async () => {} });
    await Promise.all([runner.wake(), runner.wake(), runner.wake()]);
    expect(starts).toBe(1);
});
