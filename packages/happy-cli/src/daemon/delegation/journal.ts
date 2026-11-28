import { readdirSync, watch, type FSWatcher } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { DelegatedTaskStatusSchema, type DelegatedTaskStatus, type SessionEnvelope } from '@slopus/happy-wire';
import { assertDelegationId, readDelegationJson, writeDelegationJson } from './store';
import type { Metadata } from '@/api/types';

export const DELEGATION_REPORTER_ENV = 'HAPPY_DELEGATION_REPORTER';
export const DELEGATION_RESULT_TEXT_LIMIT = 64_000;
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
const nonce = z.string().regex(/^[a-f0-9]{64}$/);
const descriptorSchema = z.object({ directory: z.string().refine(isAbsolute), taskId: id, parentSessionId: id, nonce }).strict();
export type DelegationReporterDescriptor = z.infer<typeof descriptorSchema>;
export const DelegationMessageBindingSchema = z.object({
    taskId: id, parentSessionId: id, requestId: id, version: z.number().int().positive().max(100), nonce,
}).strict();
export type DelegationMessageBinding = z.infer<typeof DelegationMessageBindingSchema>;
export interface DelegationJournalBinding extends DelegationMessageBinding { childSessionId?: string; localId: string }
export interface DelegationJournalReport extends DelegationMessageBinding {
    childSessionId: string;
    localId: string;
    sequence: number;
    status: DelegatedTaskStatus;
    updatedAt: number;
    turnId?: string;
    text: string;
    truncated: boolean;
    seenTextIds: string[];
    error?: string;
}
const readyReceiptSchema = z.object({
    taskId: id, parentSessionId: id, nonce, childSessionId: id,
    hostPid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    readyAt: z.number().int().nonnegative().max(8_640_000_000_000_000),
}).strict();
export type DelegationReadyReceipt = z.infer<typeof readyReceiptSchema>;
const journalBindingSchema = DelegationMessageBindingSchema.extend({ childSessionId: id.optional(), localId: z.string().min(1).max(512) });
const journalReportSchema = DelegationMessageBindingSchema.extend({
    childSessionId: id,
    localId: z.string().min(1).max(512),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    status: DelegatedTaskStatusSchema,
    updatedAt: z.number().int().nonnegative().max(8_640_000_000_000_000),
    turnId: z.string().min(1).max(256).optional(),
    text: z.string().max(DELEGATION_RESULT_TEXT_LIMIT),
    truncated: z.boolean(),
    seenTextIds: z.array(z.string().min(1).max(256)).max(10_000),
    error: z.string().max(4000).optional(),
});
export const delegationLocalId = (value: Pick<DelegationMessageBinding, 'taskId' | 'version' | 'requestId'>): string => `delegation:${value.taskId}:${value.version}:${value.requestId}`;
const reportName = (taskId: string, version: number) => `report-${assertDelegationId(taskId)}-${version}.json`;
const bindingName = (taskId: string, version: number) => `binding-${assertDelegationId(taskId)}-${version}.json`;
const readyName = (taskId: string) => `ready-${assertDelegationId(taskId)}.json`;
export function writeDelegationReady(directory: string, receipt: DelegationReadyReceipt): void {
    writeDelegationJson(directory, readyName(receipt.taskId), readyReceiptSchema.parse(receipt));
}
export function readDelegationReady(directory: string, taskId: string): DelegationReadyReceipt | null {
    try {
        const parsed = readyReceiptSchema.safeParse(readDelegationJson(directory, readyName(taskId)));
        return parsed.success && parsed.data.taskId === taskId ? parsed.data : null;
    } catch { return null; }
}
/** Native startup readiness travels locally, outside the relay's short RPC deadline. */
export async function waitForDelegationReady(options: {
    descriptor: DelegationReporterDescriptor; sessionId: string; hostPid: number; timeoutMs?: number;
}): Promise<DelegationReadyReceipt> {
    const descriptor = descriptorSchema.parse(options.descriptor);
    id.parse(options.sessionId);
    readyReceiptSchema.shape.hostPid.parse(options.hostPid);
    const matchingReceipt = () => {
        const value = readDelegationReady(descriptor.directory, descriptor.taskId);
        return value && value.parentSessionId === descriptor.parentSessionId && value.nonce === descriptor.nonce
            && value.childSessionId === options.sessionId && value.hostPid === options.hostPid ? value : null;
    };
    const existing = matchingReceipt();
    if (existing) return existing;
    return new Promise((resolve, reject) => {
        let watcher: FSWatcher | undefined;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const finish = (error?: Error, receipt?: DelegationReadyReceipt) => {
            if (settled) return;
            settled = true;
            if (deadline) clearTimeout(deadline);
            watcher?.close();
            if (error) reject(error); else resolve(receipt!);
        };
        const inspect = () => { const receipt = matchingReceipt(); if (receipt) finish(undefined, receipt); };
        try {
            // macOS can report an atomic replacement under its temporary filename.
            // A directory event only reads this exact protected receipt, never a scan.
            watcher = watch(descriptor.directory, { persistent: false }, inspect);
            watcher.on('error', error => finish(error));
            deadline = setTimeout(() => {
                // A single final read also covers a coalesced/lost filesystem event.
                const receipt = matchingReceipt();
                if (receipt) finish(undefined, receipt);
                else finish(new Error('Timed out waiting for delegated native model readiness'));
            }, options.timeoutMs ?? 90_000);
            // Close the read/subscribe race without querying in a loop.
            inspect();
        } catch (error) { finish(error instanceof Error ? error : new Error('Cannot observe delegated native readiness')); }
    });
}
export function parseDelegationReporterDescriptor(raw: string | undefined): DelegationReporterDescriptor | null {
    if (!raw) return null;
    try { return descriptorSchema.parse(JSON.parse(raw)); } catch { throw new Error('Invalid delegation reporter descriptor'); }
}
export function writeDelegationBinding(directory: string, binding: DelegationJournalBinding): void {
    journalBindingSchema.parse(binding);
    if (binding.localId !== delegationLocalId(binding)) throw new Error('Invalid delegation message correlation');
    writeDelegationJson(directory, bindingName(binding.taskId, binding.version), binding);
}
export function readDelegationReports(directory: string): DelegationJournalReport[] {
    return readdirSync(directory).filter(name => /^report-[a-zA-Z0-9_.-]+-\d+\.json$/.test(name))
        .flatMap(name => { const value = readDelegationReport(directory, name); return value ? [value] : []; });
}
export function readDelegationReport(directory: string, filename: string): DelegationJournalReport | null {
    if (!/^report-[a-zA-Z0-9_.-]+-\d+\.json$/.test(filename)) return null;
    try {
        const parsed = journalReportSchema.safeParse(readDelegationJson(directory, filename, 4 * 1024 * 1024));
        return parsed.success && filename === reportName(parsed.data.taskId, parsed.data.version)
            && parsed.data.localId === delegationLocalId(parsed.data) ? parsed.data : null;
    } catch { return null; }
}
const terminal = (status: DelegatedTaskStatus) => ['completed', 'failed', 'cancelled'].includes(status);

const retireRequestSchema = z.object({ hostPid: z.number().int().positive(), localId: z.string().min(1).max(512),
    expectedTurnId: z.string().min(1).max(256).optional() }).strict();
export type DelegationRetireRequest = z.infer<typeof retireRequestSchema>;

/** A failed or offline archive cannot leave the native process/bridge alive.
 * Each cleanup has one deadline; no retries or status-query loop. */
export async function finishDelegationRetirement(steps: ReadonlyArray<{ name: string; run(): unknown }>,
    onError: (name: string, error: unknown) => void, timeoutMs = 10_000): Promise<boolean> {
    let succeeded = true;
    for (const step of steps) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([Promise.resolve().then(() => step.run()), new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error(`Delegation retirement ${step.name} timed out`)), timeoutMs);
            })]);
        } catch (error) {
            succeeded = false;
            try { onError(step.name, error); } catch { /* Logging must not skip later cleanup. */ }
        } finally { if (timeout) clearTimeout(timeout); }
    }
    return succeeded;
}

/** Check authority at the worker, then synchronously fence input/configuration
 * before acknowledging. Cleanup runs through the runner's ordinary finalizer. */
export function createDelegationRetireHandler(deps: {
    launch: Pick<DelegationReporterDescriptor, 'taskId' | 'parentSessionId'> | null;
    state(): { metadata: Pick<Metadata, 'hostPid' | 'parentSessionId' | 'delegatedTask' | 'application' | 'sandbox'> | null;
        queueSize: number; pendingInputs: boolean; activeRootTurnId: string | null; thinking: boolean };
    canRetire(input: DelegationRetireRequest): boolean;
    retire(): void;
}) {
    let retiredRequest: string | undefined;
    return (raw: unknown): { retiring: true } => {
        const input = retireRequestSchema.parse(raw);
        const state = deps.state(), launch = deps.launch, metadata = state.metadata;
        if (!launch || input.hostPid !== process.pid || metadata?.hostPid !== process.pid
            || metadata.parentSessionId !== launch.parentSessionId || metadata.delegatedTask?.taskId !== launch.taskId
            || metadata.delegatedTask.parentSessionId !== launch.parentSessionId || metadata.application || metadata.sandbox?.enabled) {
            throw new Error('Delegated worker retirement ownership changed');
        }
        const identity = JSON.stringify(input);
        if (retiredRequest === identity) return { retiring: true };
        if (retiredRequest || state.queueSize || state.pendingInputs
            || (state.activeRootTurnId && state.activeRootTurnId !== input.expectedTurnId)
            || (!input.expectedTurnId && (state.thinking || state.activeRootTurnId)) || !deps.canRetire(input)) {
            throw new Error('Delegated worker has no matching settled input or became busy');
        }
        retiredRequest = identity;
        deps.retire();
        return { retiring: true };
    };
}

/** A worker only reports its explicitly bound input and root turn. No timers or network requests. */
export function createDelegationReporter({ descriptor, sessionId }: { descriptor: DelegationReporterDescriptor; sessionId: string }) {
    descriptorSchema.parse(descriptor);
    assertDelegationId(sessionId);
    const reports = new Map<string, DelegationJournalReport>();
    const queuedCancellations = new Set<string>();
    let nativeReady = false;
    const save = (report: DelegationJournalReport): void => {
        report.sequence += 1;
        report.updatedAt = Date.now();
        writeDelegationJson(descriptor.directory, reportName(report.taskId, report.version), report);
    };
    const matchesDescriptor = (binding: DelegationMessageBinding) => binding.taskId === descriptor.taskId
        && binding.parentSessionId === descriptor.parentSessionId && binding.nonce === descriptor.nonce;
    return {
        canRetire(input: Pick<DelegationRetireRequest, 'localId' | 'expectedTurnId'>): boolean {
            const parts = input.localId.split(':');
            if (parts.length !== 4 || parts[0] !== 'delegation' || parts[1] !== descriptor.taskId || !/^[1-9][0-9]*$/.test(parts[2])) return false;
            try {
                const binding = journalBindingSchema.parse(readDelegationJson(descriptor.directory, bindingName(descriptor.taskId, Number(parts[2]))));
                if (!matchesDescriptor(binding) || binding.childSessionId !== sessionId || binding.localId !== input.localId
                    || delegationLocalId(binding) !== input.localId) return false;
                if (!input.expectedTurnId) {
                    const prior = readDelegationJson(descriptor.directory, reportName(binding.taskId, binding.version), 4 * 1024 * 1024);
                    if (reports.size === 0) return prior === null;
                    const accepted = reports.get(input.localId);
                    const saved = journalReportSchema.safeParse(prior);
                    return reports.size === 1 && queuedCancellations.has(input.localId) && !!accepted && !accepted.turnId
                        && saved.success && !saved.data.turnId && matchesDescriptor(saved.data)
                        && saved.data.childSessionId === sessionId && saved.data.localId === input.localId;
                }
                if (!reports.has(input.localId)) return false;
                const report = readDelegationReport(descriptor.directory, reportName(binding.taskId, binding.version));
                return !!report && matchesDescriptor(report) && report.childSessionId === sessionId && report.localId === input.localId
                    && report.requestId === binding.requestId && report.version === binding.version
                    && report.turnId === input.expectedTurnId && terminal(report.status);
            } catch { return false; }
        },
        acknowledgeQueuedCancellation(localId: string): void {
            const report = reports.get(localId);
            if (report && !report.turnId) queuedCancellations.add(localId);
        },
        ready(): void {
            if (nativeReady) return;
            writeDelegationReady(descriptor.directory, { taskId: descriptor.taskId, parentSessionId: descriptor.parentSessionId,
                nonce: descriptor.nonce, childSessionId: sessionId, hostPid: process.pid, readyAt: Date.now() });
            nativeReady = true;
        },
        acceptMessage(message: { localId?: string | null; meta?: { delegation?: unknown } }): boolean {
            if (!message.meta?.delegation) return false;
            const parsed = DelegationMessageBindingSchema.safeParse(message.meta.delegation);
            if (!parsed.success || !matchesDescriptor(parsed.data)) return false;
            const binding = parsed.data;
            if (message.localId !== delegationLocalId(binding)) return false;
            let expected: z.infer<typeof journalBindingSchema>;
            let previous: DelegationJournalReport | undefined;
            try {
                expected = journalBindingSchema.parse(readDelegationJson(descriptor.directory, bindingName(binding.taskId, binding.version)));
                const previousRaw = readDelegationJson(descriptor.directory, reportName(binding.taskId, binding.version), 4 * 1024 * 1024);
                if (previousRaw !== null) previous = journalReportSchema.parse(previousRaw);
            } catch { return false; }
            if (expected.childSessionId !== sessionId || expected.localId !== message.localId
                || expected.taskId !== binding.taskId || expected.version !== binding.version
                || expected.nonce !== binding.nonce || expected.requestId !== binding.requestId || expected.parentSessionId !== binding.parentSessionId) return false;
            if (reports.has(message.localId)) return true;
            if (previous && (previous.childSessionId !== sessionId || previous.nonce !== binding.nonce || previous.localId !== message.localId
                || previous.taskId !== binding.taskId || previous.version !== binding.version || previous.requestId !== binding.requestId || previous.parentSessionId !== binding.parentSessionId)) return false;
            if (previous && terminal(previous.status)) return false;
            const report: DelegationJournalReport = previous ?? { ...binding, childSessionId: sessionId, localId: message.localId,
                sequence: 0, status: 'starting', updatedAt: Date.now(), text: '', truncated: false, seenTextIds: [] };
            reports.set(message.localId, report);
            if (!previous) save(report);
            return true;
        },
        observe(envelope: SessionEnvelope): void {
            if (envelope.subagent || envelope.role !== 'agent') return;
            for (const report of reports.values()) {
                if (terminal(report.status)) continue;
                if (envelope.ev.t === 'turn-start') {
                    const localIds = [...new Set(envelope.ev.localIds ?? [])];
                    if (!localIds.includes(report.localId) || (report.turnId && report.turnId !== envelope.turn)) continue;
                    if (localIds.length !== 1 || !envelope.turn) {
                        report.status = 'interrupted'; report.error = 'Delegated input was not isolated to one root turn'; save(report); continue;
                    }
                    if (report.turnId === envelope.turn && report.status === 'running') continue;
                    report.turnId = envelope.turn; report.status = 'running'; delete report.error; save(report);
                } else if (envelope.turn && envelope.turn === report.turnId && envelope.ev.t === 'text' && !envelope.ev.thinking) {
                    if (report.seenTextIds.includes(envelope.id)) continue;
                    if (report.seenTextIds.length >= 10_000) { report.truncated = true; save(report); continue; }
                    report.seenTextIds.push(envelope.id);
                    const remaining = Math.max(0, DELEGATION_RESULT_TEXT_LIMIT - report.text.length);
                    const text = (report.text ? '\n\n' : '') + envelope.ev.text;
                    report.text += text.slice(0, remaining);
                    if (text.length > remaining) report.truncated = true;
                    save(report);
                } else if (envelope.turn && envelope.turn === report.turnId && envelope.ev.t === 'turn-end') {
                    report.status = envelope.ev.status; save(report);
                }
            }
        },
        waitingForInput(waiting: boolean, turnId?: string): void {
            for (const report of reports.values()) {
                if (!report.turnId || (turnId && report.turnId !== turnId) || terminal(report.status)) continue;
                const status = waiting ? 'waiting-for-input' : 'running';
                if (report.status !== status) { report.status = status; save(report); }
            }
        },
        rejectMessage(localId: string): void {
            const report = reports.get(localId);
            if (report && !report.turnId && !terminal(report.status)) {
                report.status = 'interrupted'; report.error = 'Delegated input was discarded before a root turn started'; save(report);
            }
        },
        processorStartupFailed(): void {
            for (const report of reports.values()) {
                if (terminal(report.status)) continue;
                report.status = 'interrupted'; report.error = 'Delegated worker stopped before completion was confirmed'; save(report);
            }
        },
    };
}
