/** Event-driven claim/delivery. An uncertain launch/send is never automatically replayed. */
import { isAbsolute } from 'node:path';
import { ScheduledTaskConfigSchema, isScheduledRunTerminal, type ScheduledRun, type ScheduledRunClaim, type ScheduledRunReport, type ScheduledTaskConfig } from '@slopus/happy-wire';
import { createScheduleJournal, type ScheduledSessionBinding } from './journal';

export interface ScheduledRunnerDependencies {
    journal: ReturnType<typeof createScheduleJournal>;
    decrypt: (ciphertext: string) => unknown;
    validate?: (config: ScheduledTaskConfig) => Promise<void>;
    claim: () => Promise<ScheduledRunClaim[]>;
    start: (config: ScheduledTaskConfig, binding: ScheduledSessionBinding | null) => Promise<ScheduledSessionBinding>;
    send: (binding: ScheduledSessionBinding, run: ScheduledRun, config: ScheduledTaskConfig) => Promise<void>;
    report: (run: ScheduledRun, report: ScheduledRunReport) => Promise<void>;
    attention?: (run: ScheduledRun) => void;
    flushReceipts?: () => Promise<void>;
    runLocal?: (run: ScheduledRun, config: ScheduledTaskConfig) => Promise<void>;
    /** Claim the next slot on completed delivery, not on a recurring timer. */
    drainClaims?: boolean;
}
export function createScheduledTaskRunner(deps: ScheduledRunnerDependencies) {
    let running: Promise<void> | null = null, dirty = false, stopped = false;
    async function execute(run: ScheduledRunClaim): Promise<void> {
        // A recovery claim is an observation. Another daemon may still be
        // starting this run, including when the journal is shared or unreadable.
        // Only the fresh atomic claim owns delivery; the server deadline handles
        // recovery without evidence that its original owner has stopped.
        if (isScheduledRunTerminal(run.status) || !run.claimId || !run.deliveryAuthorized) return;
        let existing: ReturnType<typeof deps.journal.readRun> = null;
        let journalRead = false;
        let localStarted = false;
        try {
            existing = deps.journal.readRun(run.id);
            journalRead = true;
            if (existing) {
                if (run.status === 'claimed' && ['starting', 'bound', 'sending'].includes(existing.phase)) {
                    await deps.report(run, { claimId: run.claimId, status: 'uncertain', reason: 'delivery-uncertain', ...(existing.sessionId ? { sessionId: existing.sessionId } : {}) });
                }
                return;
            }
            if (run.status !== 'claimed' || run.sessionId || run.turnId) {
                if (run.status === 'claimed') await deps.report(run, { claimId: run.claimId, status: 'uncertain', reason: 'journal-unavailable', ...(run.sessionId ? { sessionId: run.sessionId } : {}) });
                return;
            }
            const config = ScheduledTaskConfigSchema.parse(deps.decrypt(run.encryptedConfig));
            if (!isAbsolute(config.directory)) throw new Error('Working directory must be absolute');
            if (run.executionKind === 'local-handler') {
                if (!deps.runLocal || !config.localHandlerId || !run.newChatEachRun) throw new Error('Local handler unavailable');
                localStarted = true;
                await deps.runLocal(run, config);
                return;
            }
            if (config.localHandlerId) throw new Error('Local handler requires explicit execution kind');
            await deps.validate?.(config);
            const saved = run.newChatEachRun ? null : deps.journal.readBinding(run.taskId, run.bindingVersion);
            if (!run.newChatEachRun && run.conversationSessionId && (!saved || saved.sessionId !== run.conversationSessionId)) {
                await deps.report(run, { claimId: run.claimId, status: 'uncertain', reason: 'binding-unavailable' });
                return;
            }
            if (saved && (saved.agent !== config.agent || saved.directory !== config.directory || (config.codexAccountProfileId && saved.profileId !== config.codexAccountProfileId))) throw new Error('Task conversation binding changed');
            existing = { runId: run.id, taskId: run.taskId, phase: 'starting' };
            deps.journal.writeRun(existing);
            const binding = await deps.start(config, saved);
            if (!run.newChatEachRun) deps.journal.writeBinding(run.taskId, run.bindingVersion, binding);
            existing = { ...existing, phase: 'bound', sessionId: binding.sessionId };
            deps.journal.writeRun(existing);
            await deps.report(run, { claimId: run.claimId, status: 'claimed', sessionId: binding.sessionId });
            deps.journal.writeRun({ ...existing, phase: 'sending' });
            await deps.send(binding, run, config);
            deps.journal.writeRun({ ...existing, phase: 'sent' });
        } catch (error) {
            // The local executor owns its receipt. Do not overwrite a completed
            // result with a failed report merely because its network ACK was lost.
            if (localStarted) throw error;
            // Once launch began, a thrown error does not prove the child or prompt never existed.
            await deps.report(run, { claimId: run.claimId, status: existing || !journalRead ? 'uncertain' : 'failed', reason: existing || !journalRead ? 'delivery-uncertain' : 'configuration-invalid',
                ...(existing?.sessionId ? { sessionId: existing.sessionId } : {}) });
            if (run.notificationPolicy !== 'none') deps.attention?.(run);
        }
    }
    const wake = (): Promise<void> => {
        if (stopped) return Promise.resolve();
        dirty = true;
        if (running) return running;
        running = (async () => {
            await deps.flushReceipts?.();
            do {
                dirty = false;
                for (const run of await deps.claim()) {
                    if (stopped) break;
                    await execute(run);
                    if (deps.drainClaims && run.deliveryAuthorized) dirty = true;
                }
            } while (dirty && !stopped);
        })().finally(() => { running = null; });
        return running;
    };
    return { wake, stop() { stopped = true; } };
}
