/** Correlates scheduled prompt localIds with root turns; durable receipts survive disconnected workers. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ScheduledPromptSchema, ScheduledRunReportSchema, isScheduledRunTerminal,
    type ScheduledPrompt, type ScheduledRunReport, type SessionEnvelope } from '@slopus/happy-wire';
import { writeScheduleJournalFile } from '@/daemon/scheduledTasks/journal';

interface Receipt { prompt: ScheduledPrompt; localId: string; sessionId: string; report: ScheduledRunReport; sequence: number }
const policies = new Map<string, ScheduledPrompt['notificationPolicy']>();
function acknowledged(directory: string, runId: string): number {
    try { return Number(JSON.parse(readFileSync(join(directory, `ack-${runId}.json`), 'utf8')).sequence); } catch { return -1; }
}
async function sendReceipt(directory: string, receipt: Receipt, send: (taskId: string, runId: string, report: ScheduledRunReport) => Promise<void>): Promise<void> {
    const sequence = receipt.sequence;
    if (acknowledged(directory, receipt.prompt.runId) >= sequence) return;
    await send(receipt.prompt.taskId, receipt.prompt.runId, { ...receipt.report, sequence });
    // A separate acknowledgement file cannot overwrite a newer worker receipt.
    writeScheduleJournalFile(directory, `ack-${receipt.prompt.runId}.json`, { sequence: Math.max(sequence, acknowledged(directory, receipt.prompt.runId)) });
}
export function scheduledNotificationPolicy(sessionId: string): ScheduledPrompt['notificationPolicy'] | undefined { return policies.get(sessionId); }
function readReceipts(directory: string): Receipt[] {
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(name => /^receipt-[0-9a-f-]{36}\.json$/.test(name)).flatMap(name => {
        try {
            const value = JSON.parse(readFileSync(join(directory, name), 'utf8')) as Receipt;
            ScheduledPromptSchema.parse(value.prompt); ScheduledRunReportSchema.parse(value.report);
            return [value];
        } catch { return []; }
    });
}
export async function flushScheduledReceipts(directory: string, send: (taskId: string, runId: string, report: ScheduledRunReport) => Promise<void>): Promise<void> {
    for (const receipt of readReceipts(directory)) {
        try { await sendReceipt(directory, receipt, send); } catch { /* Next connection retries this same receipt, never the prompt. */ }
    }
}
export function createScheduledRunTracker(deps: {
    directory: string; sessionId: string;
    send: (taskId: string, runId: string, report: ScheduledRunReport) => Promise<void>;
    attention?: () => void;
}) {
    const receipts = new Map(readReceipts(deps.directory).filter(r => r.sessionId === deps.sessionId).map(r => [r.prompt.runId, r]));
    let sending = Promise.resolve();
    let activeTurnId: string | undefined;
    const flush = () => {
        sending = sending.then(async () => {
            for (const receipt of receipts.values()) {
                try { await sendReceipt(deps.directory, receipt, deps.send); } catch { /* Persisted for reconnect. */ }
            }
        });
        return sending;
    };
    const update = (receipt: Receipt, report: ScheduledRunReport) => {
        receipt.report = report; receipt.sequence++;
        writeScheduleJournalFile(deps.directory, `receipt-${receipt.prompt.runId}.json`, receipt);
        void flush();
    };
    return {
        flush,
        hasMessage(localId: string): boolean { return [...receipts.values()].some(receipt => receipt.localId === localId); },
        rejectMessage(localId: string): void {
            const receipt = [...receipts.values()].find(receipt => receipt.localId === localId);
            if (receipt && !receipt.report.turnId) update(receipt, { ...receipt.report, status: 'failed', reason: 'input-rejected' });
        },
        acceptMessage(message: { localId?: string; meta?: { scheduledRun?: unknown } }): void {
            const parsed = ScheduledPromptSchema.safeParse(message.meta?.scheduledRun);
            if (!parsed.success || message.localId !== `scheduled:${parsed.data.runId}` || receipts.has(parsed.data.runId)) return;
            const receipt: Receipt = { prompt: parsed.data, localId: message.localId, sessionId: deps.sessionId, sequence: 0,
                report: { claimId: parsed.data.claimId, sessionId: deps.sessionId, status: 'claimed' } };
            receipts.set(parsed.data.runId, receipt);
            writeScheduleJournalFile(deps.directory, `receipt-${parsed.data.runId}.json`, receipt);
        },
        observe(envelope: SessionEnvelope): void {
            if (envelope.subagent || envelope.role === 'user') return;
            if (envelope.ev.t === 'turn-start') {
                activeTurnId = envelope.turn;
                const localIds = envelope.ev.localIds ?? [];
                let matched = false;
                for (const receipt of receipts.values()) {
                    if (isScheduledRunTerminal(receipt.report.status) || !localIds.includes(receipt.localId)) continue;
                    if (receipt.report.turnId && receipt.report.turnId !== envelope.turn) continue;
                    matched = true; policies.set(deps.sessionId, receipt.prompt.notificationPolicy);
                    update(receipt, { ...receipt.report, status: 'running', turnId: envelope.turn });
                }
                if (!matched) policies.delete(deps.sessionId);
            } else if (envelope.ev.t === 'turn-end') {
                if (activeTurnId === envelope.turn) activeTurnId = undefined;
                for (const receipt of receipts.values()) {
                    if (!receipt.report.turnId || receipt.report.turnId !== envelope.turn || isScheduledRunTerminal(receipt.report.status)) continue;
                    const status = envelope.ev.status === 'completed' ? 'completed' : envelope.ev.status === 'failed' ? 'failed' : 'cancelled';
                    update(receipt, { ...receipt.report, status });
                    if (status === 'failed' && receipt.prompt.notificationPolicy !== 'none') deps.attention?.();
                }
            }
        },
        waitingForInput(waiting: boolean, turnId?: string): void {
            for (const receipt of receipts.values()) {
                if (!receipt.report.turnId || receipt.report.turnId !== activeTurnId || (turnId && receipt.report.turnId !== turnId) || isScheduledRunTerminal(receipt.report.status)) continue;
                const status = waiting ? 'waiting-for-input' : 'running';
                if (receipt.report.status === status) continue;
                update(receipt, { ...receipt.report, status });
            }
        },
    };
}
