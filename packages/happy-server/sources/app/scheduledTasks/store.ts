/** Account-isolated durable plans/runs in a reserved KV namespace; all mutations are serializable. */
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { allocateUserSeqBatch } from '@/storage/seq';
import { SCHEDULED_TASK_PREFIX, ScheduledTaskInputSchema, ScheduledRunReportSchema, nextScheduledAt, isScheduledRunTerminal,
    type ScheduledTask, type ScheduledTaskInput, type ScheduledRun, type ScheduledRunReport, type ScheduledRunClaim } from '@slopus/happy-wire';

type Tx = Prisma.TransactionClient;
type StoredTask = ScheduledTask & { deleted?: boolean };
type Row = { key: string; value: Uint8Array | null; version: number };
export interface ScheduledTaskChange { accountId: string; task: StoredTask; run?: ScheduledRun }
export class ScheduledTaskError extends Error {
    constructor(public readonly code: string, public readonly status = 409) { super(code); }
}
const taskKey = (id: string) => `${SCHEDULED_TASK_PREFIX}task:${id}`;
const runPrefix = (id: string) => `${SCHEDULED_TASK_PREFIX}run:${id}:`;
const runKey = (taskId: string, id: string) => runPrefix(taskId) + id;
const decode = <T>(row: Row | null): T | null => row?.value ? JSON.parse(new TextDecoder().decode(row.value)) as T : null;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

export interface ScheduledMessageCreated { accountId: string; sessionId: string; userSeq: number; message: { id: string; seq: number; localId: string | null; content: { t: 'encrypted'; c: string }; createdAt: Date; updatedAt: Date } }
export function createScheduledTaskStore(database: PrismaClient, options: { now?: () => number; onMessage?: (created: ScheduledMessageCreated) => void } = {}) {
    const now = options.now ?? Date.now;
    const listeners = new Set<(change: ScheduledTaskChange) => void>();
    const emit = (change: ScheduledTaskChange) => { for (const listener of listeners) listener(change); };
    const read = (tx: Tx, accountId: string, key: string) => tx.userKVStore.findUnique({ where: { accountId_key: { accountId, key } } });
    const rows = (tx: Tx, accountId: string, prefix: string) => tx.userKVStore.findMany({ where: { accountId, key: { startsWith: prefix }, value: { not: null } } });
    async function transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
        for (let attempt = 0; ; attempt++) {
            try { return await database.$transaction(fn, { isolationLevel: 'Serializable', timeout: 10000, maxWait: 10000 }); }
            catch (error) {
                if (attempt < 3 && error instanceof Prisma.PrismaClientKnownRequestError && ['P2034', 'P2002'].includes(error.code)) continue;
                throw error;
            }
        }
    }
    async function write(tx: Tx, accountId: string, key: string, value: unknown, row: Row | null) {
        if (!row) await tx.userKVStore.create({ data: { accountId, key, value: bytes(value) } });
        else {
            const result = await tx.userKVStore.updateMany({ where: { accountId, key, version: row.version }, data: { value: bytes(value), version: { increment: 1 } } });
            if (result.count !== 1) throw new ScheduledTaskError('version-conflict');
        }
    }
    async function readTask(tx: Tx, accountId: string, id: string) {
        const row = await read(tx, accountId, taskKey(id));
        const task = decode<StoredTask>(row);
        if (!task) throw new ScheduledTaskError('task-not-found', 404);
        return { row: row!, task };
    }
    async function readRun(tx: Tx, accountId: string, taskId: string, id: string) {
        const row = await read(tx, accountId, runKey(taskId, id));
        const run = decode<ScheduledRun>(row);
        if (!run) throw new ScheduledTaskError('run-not-found', 404);
        return { row: row!, run };
    }
    async function prune(tx: Tx, accountId: string, taskId: string) {
        const history = (await rows(tx, accountId, runPrefix(taskId))).map(row => ({ row, run: decode<ScheduledRun>(row)! }))
            .filter(item => isScheduledRunTerminal(item.run.status)).sort((a, b) => b.run.createdAt - a.run.createdAt || b.row.key.localeCompare(a.row.key));
        const discarded = history.slice(100).map(item => item.row.key);
        if (discarded.length) await tx.userKVStore.deleteMany({ where: { accountId, key: { in: discarded } } });
    }
    async function createRun(tx: Tx, accountId: string, task: StoredTask, scheduledAt: number, id: string = randomUUID()): Promise<ScheduledRun> {
        const instant = now();
        const run: ScheduledRun = { id, taskId: task.id, machineId: task.machineId, scheduledAt, createdAt: instant, updatedAt: instant,
            status: 'pending', encryptedConfig: task.encryptedConfig, newChatEachRun: task.newChatEachRun, bindingVersion: task.bindingVersion,
            notificationPolicy: task.notificationPolicy, claimId: null, sessionId: null, turnId: null,
            startedAt: null, finishedAt: null, reason: null, missedUntil: null, deadlineAt: null,
            conversationSessionId: task.newChatEachRun ? null : task.conversationSessionId, reportSequence: 0 };
        await write(tx, accountId, runKey(task.id, id), run, null);
        await prune(tx, accountId, task.id);
        return run;
    }
    async function cancelPending(tx: Tx, accountId: string, task: StoredTask) {
        if (!task.activeRunId) return;
        const { row, run } = await readRun(tx, accountId, task.id, task.activeRunId);
        if (run.status !== 'pending') return;
        await write(tx, accountId, row.key, { ...run, status: 'cancelled', reason: 'task-paused', finishedAt: now(), updatedAt: now() }, row);
        task.activeRunId = null;
        await prune(tx, accountId, task.id);
    }
    return {
        onChange(listener: (change: ScheduledTaskChange) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        async list(accountId: string): Promise<ScheduledTask[]> {
            return (await rows(database, accountId, SCHEDULED_TASK_PREFIX + 'task:')).map(row => decode<StoredTask>(row)!).filter(task => !task.deleted);
        },
        async restore(): Promise<Array<{ accountId: string; task: StoredTask; run?: ScheduledRun }>> {
            const all = await database.userKVStore.findMany({ where: { key: { startsWith: SCHEDULED_TASK_PREFIX + 'task:' }, value: { not: null } } });
            const result: Array<ScheduledTaskChange> = [];
            for (const row of all) {
                const task = decode<StoredTask>(row)!;
                const active = task.activeRunId ? decode<ScheduledRun>(await read(database, row.accountId, runKey(task.id, task.activeRunId))) : null;
                result.push({ accountId: row.accountId, task, ...(active ? { run: active } : {}) });
            }
            return result;
        },
        async history(accountId: string, taskId: string): Promise<ScheduledRun[]> {
            await readTask(database, accountId, taskId);
            return (await rows(database, accountId, runPrefix(taskId))).map(row => decode<ScheduledRun>(row)!).sort((a, b) => b.createdAt - a.createdAt);
        },
        async save(accountId: string, raw: ScheduledTaskInput, expectedVersion: number, resetBinding = false): Promise<ScheduledTask> {
            const input = ScheduledTaskInputSchema.parse(raw);
            const task = await transaction(async tx => {
                if (!await tx.machine.findFirst({ where: { id: input.machineId, accountId } })) throw new ScheduledTaskError('machine-not-found', 404);
                const row = await read(tx, accountId, taskKey(input.id));
                const previous = decode<StoredTask>(row);
                if (row && expectedVersion === -1 && previous && Object.entries(input).every(([key, value]) => JSON.stringify(previous[key as keyof StoredTask]) === JSON.stringify(value))) return previous;
                if ((row?.version ?? -1) !== expectedVersion || previous?.deleted) throw new ScheduledTaskError('version-conflict');
                if (!previous && (await rows(tx, accountId, SCHEDULED_TASK_PREFIX + 'task:')).filter(r => !decode<StoredTask>(r)!.deleted).length >= 100) throw new ScheduledTaskError('task-limit', 429);
                if (previous?.activeRunId && (resetBinding || input.machineId !== previous.machineId)) throw new ScheduledTaskError('task-busy');
                if (previous && input.machineId !== previous.machineId && !resetBinding) throw new ScheduledTaskError('binding-reset-required');
                if (input.rule.type === 'once' && input.rule.at <= now() && (input.enabled || !previous)) throw new ScheduledTaskError('time-must-be-future', 400);
                const next: StoredTask = { ...input, version: (row?.version ?? -1) + 1, createdAt: previous?.createdAt ?? now(), updatedAt: now(),
                    nextAt: input.enabled ? nextScheduledAt(input.rule, now()) : null, activeRunId: previous?.activeRunId ?? null,
                    conversationSessionId: resetBinding ? null : previous?.conversationSessionId ?? null,
                    bindingVersion: (previous?.bindingVersion ?? 0) + (resetBinding ? 1 : 0) };
                if (!input.enabled) await cancelPending(tx, accountId, next);
                await write(tx, accountId, taskKey(input.id), next, row);
                return next;
            });
            emit({ accountId, task }); return task;
        },
        async remove(accountId: string, id: string, version: number): Promise<void> {
            const task = await transaction(async tx => {
                const { row, task } = await readTask(tx, accountId, id);
                if (row.version !== version) throw new ScheduledTaskError('version-conflict');
                await cancelPending(tx, accountId, task);
                const next = { ...task, deleted: true, enabled: false, nextAt: null, updatedAt: now(), version: row.version + 1 };
                await write(tx, accountId, row.key, next, row); return next;
            });
            emit({ accountId, task });
        },
        async due(accountId: string, id: string, at: number): Promise<ScheduledRun | null> {
            const change = await transaction(async tx => {
                const { row, task } = await readTask(tx, accountId, id);
                if (task.deleted || !task.enabled || task.nextAt === null || task.nextAt > at) return null;
                const scheduledAt = task.nextAt;
                task.nextAt = nextScheduledAt(task.rule, at); task.enabled = task.nextAt !== null;
                task.version = row.version + 1; task.updatedAt = now();
                let run: ScheduledRun;
                if (task.activeRunId) {
                    const active = await readRun(tx, accountId, id, task.activeRunId);
                    if (active.run.status === 'pending') {
                        run = { ...active.run, missedUntil: at, updatedAt: now() };
                        await write(tx, accountId, active.row.key, run, active.row);
                    } else {
                        run = await createRun(tx, accountId, task, scheduledAt);
                        run.status = 'skipped'; run.reason = 'previous-run-active'; run.finishedAt = now();
                        const added = await read(tx, accountId, runKey(id, run.id));
                        await write(tx, accountId, runKey(id, run.id), run, added);
                        await prune(tx, accountId, id);
                    }
                } else {
                    run = await createRun(tx, accountId, task, scheduledAt);
                    if (at > scheduledAt + 1000) run.missedUntil = at;
                    if (run.missedUntil) await write(tx, accountId, runKey(id, run.id), run, await read(tx, accountId, runKey(id, run.id)));
                    task.activeRunId = run.id;
                }
                await write(tx, accountId, row.key, task, row);
                return { accountId, task, run };
            });
            if (change) emit(change); return change?.run ?? null;
        },
        async runNow(accountId: string, taskId: string, requestId: string): Promise<ScheduledRun> {
            const change = await transaction(async tx => {
                const { row, task } = await readTask(tx, accountId, taskId);
                if (task.deleted) throw new ScheduledTaskError('task-not-found', 404);
                const requestKey = `${SCHEDULED_TASK_PREFIX}request:${taskId}:${requestId}`;
                const priorRequest = decode<{ runId: string }>(await read(tx, accountId, requestKey));
                if (priorRequest) return { accountId, task, run: (await readRun(tx, accountId, taskId, priorRequest.runId)).run, changed: false };
                const existing = decode<ScheduledRun>(await read(tx, accountId, runKey(taskId, requestId)));
                if (existing) return { accountId, task, run: existing, changed: false };
                if (task.activeRunId) {
                    await write(tx, accountId, requestKey, { runId: task.activeRunId }, null);
                    return { accountId, task, run: (await readRun(tx, accountId, taskId, task.activeRunId)).run, changed: false };
                }
                const run = await createRun(tx, accountId, task, now());
                await write(tx, accountId, requestKey, { runId: run.id }, null);
                task.activeRunId = run.id; task.version = row.version + 1; task.updatedAt = now();
                await write(tx, accountId, row.key, task, row);
                return { accountId, task, run, changed: true };
            });
            if (change.changed) emit(change); return change.run;
        },
        async claim(accountId: string, machineId: string): Promise<ScheduledRunClaim[]> {
            if (!await database.machine.findFirst({ where: { id: machineId, accountId } })) throw new ScheduledTaskError('machine-not-found', 404);
            const changes = await transaction(async tx => {
                const result: Array<ScheduledTaskChange & { deliveryAuthorized: boolean }> = [];
                for (const row of await rows(tx, accountId, SCHEDULED_TASK_PREFIX + 'task:')) {
                    const task = decode<StoredTask>(row)!;
                    if (!task.activeRunId) continue;
                    const active = await readRun(tx, accountId, task.id, task.activeRunId);
                    if (active.run.machineId !== machineId || isScheduledRunTerminal(active.run.status)) continue;
                    const deliveryAuthorized = active.run.status === 'pending';
                    if (deliveryAuthorized) {
                        active.run.status = 'claimed'; active.run.claimId = randomUUID(); active.run.updatedAt = now(); active.run.deadlineAt = now() + 86_400_000;
                        await write(tx, accountId, active.row.key, active.run, active.row);
                    }
                    result.push({ accountId, task, run: active.run, deliveryAuthorized });
                }
                return result;
            });
            for (const change of changes) if (change.deliveryAuthorized) emit(change);
            return changes.map(change => ({ ...change.run!, deliveryAuthorized: change.deliveryAuthorized }));
        },
        async report(accountId: string, taskId: string, id: string, raw: ScheduledRunReport): Promise<ScheduledRun> {
            const report = ScheduledRunReportSchema.parse(raw);
            const change = await transaction(async tx => {
                const { row: taskRow, task } = await readTask(tx, accountId, taskId);
                const { row, run } = await readRun(tx, accountId, taskId, id);
                if (!run.claimId || report.claimId !== run.claimId) throw new ScheduledTaskError('claim-conflict', 403);
                if ((run.sessionId && report.sessionId && report.sessionId !== run.sessionId) || (run.turnId && report.turnId && report.turnId !== run.turnId)) throw new ScheduledTaskError('run-binding-conflict');
                if (isScheduledRunTerminal(run.status)) return { accountId, task, run, changed: false };
                if (report.sequence !== undefined && report.sequence <= run.reportSequence && report.status !== 'claimed') return { accountId, task, run, changed: false };
                if (run.status === 'uncertain' && !isScheduledRunTerminal(report.status)) return { accountId, task, run, changed: false };
                if (run.status === report.status && (!report.sessionId || run.sessionId === report.sessionId) && (!report.turnId || run.turnId === report.turnId) && (report.reason ?? null) === run.reason) {
                    if (report.sequence !== undefined && report.sequence > run.reportSequence) {
                        run.reportSequence = report.sequence;
                        await write(tx, accountId, row.key, run, row);
                    }
                    return { accountId, task, run, changed: false };
                }
                if (report.sessionId && !await tx.session.findFirst({ where: { id: report.sessionId, accountId } })) throw new ScheduledTaskError('session-not-found', 404);
                if (!run.newChatEachRun && report.sessionId && task.bindingVersion === run.bindingVersion) {
                    if (task.conversationSessionId && task.conversationSessionId !== report.sessionId) throw new ScheduledTaskError('run-binding-conflict');
                    if (!task.conversationSessionId) { task.conversationSessionId = report.sessionId; task.version = taskRow.version + 1; await write(tx, accountId, taskRow.key, task, taskRow); taskRow.version++; }
                }
                if (['running', 'waiting-for-input', 'completed'].includes(report.status) && (!report.sessionId || !report.turnId)) throw new ScheduledTaskError('turn-required', 400);
                if (run.sessionId && ['failed', 'cancelled'].includes(report.status) && !report.turnId && report.reason !== 'input-rejected') throw new ScheduledTaskError('turn-required', 400);
                if (report.status === 'claimed' && run.status !== 'claimed') return { accountId, task, run, changed: false };
                const next: ScheduledRun = { ...run, ...report, sessionId: report.sessionId ?? run.sessionId, turnId: report.turnId ?? run.turnId,
                    reportSequence: report.sequence ?? run.reportSequence,
                    reason: report.reason ?? null, updatedAt: now(), startedAt: run.startedAt ?? (report.status === 'running' ? now() : null),
                    finishedAt: isScheduledRunTerminal(report.status) ? now() : null };
                await write(tx, accountId, row.key, next, row);
                if (isScheduledRunTerminal(next.status) && task.activeRunId === id) { task.activeRunId = null; task.version = taskRow.version + 1; task.updatedAt = now(); await write(tx, accountId, taskRow.key, task, taskRow); }
                await prune(tx, accountId, taskId);
                return { accountId, task, run: next, changed: true };
            });
            if (change.changed) emit(change); return change.run;
        },
        async deliver(accountId: string, taskId: string, runId: string, input: { claimId: string; content: string; expectedSessionSeq: number }): Promise<void> {
            const created = await transaction(async tx => {
                const { task } = await readTask(tx, accountId, taskId);
                const { run } = await readRun(tx, accountId, taskId, runId);
                if (run.claimId !== input.claimId || !run.sessionId || run.status !== 'claimed' || task.activeRunId !== runId) throw new ScheduledTaskError('delivery-unavailable');
                const localId = `scheduled:${runId}`;
                const prior = await tx.sessionMessage.findFirst({ where: { sessionId: run.sessionId, localId } });
                if (prior) {
                    const previous = prior.content as { t?: unknown; c?: unknown } | null;
                    if (previous?.t !== 'encrypted' || previous.c !== input.content) throw new ScheduledTaskError('delivery-unavailable');
                    return null;
                }
                const changed = await tx.session.updateMany({ where: { id: run.sessionId, accountId, seq: input.expectedSessionSeq }, data: { seq: { increment: 1 } } });
                if (changed.count !== 1) throw new ScheduledTaskError('conversation-changed');
                const content = { t: 'encrypted' as const, c: input.content };
                const message = await tx.sessionMessage.create({ data: { sessionId: run.sessionId, seq: input.expectedSessionSeq + 1, localId, content } });
                const [userSeq] = await allocateUserSeqBatch(accountId, 1, tx);
                return { accountId, sessionId: run.sessionId, userSeq, message: { ...message, content } };
            });
            if (created) options.onMessage?.(created);
        },
        async abandon(accountId: string, taskId: string, id: string): Promise<void> {
            const change = await transaction(async tx => {
                const { row: taskRow, task } = await readTask(tx, accountId, taskId);
                const { row, run } = await readRun(tx, accountId, taskId, id);
                if (!['uncertain', 'waiting-for-input'].includes(run.status)) throw new ScheduledTaskError('run-not-blocked');
                run.status = 'cancelled'; run.reason = 'tracking-ended'; run.updatedAt = now(); run.finishedAt = now();
                await write(tx, accountId, row.key, run, row);
                if (task.activeRunId === id) { task.activeRunId = null; task.version = taskRow.version + 1; await write(tx, accountId, taskRow.key, task, taskRow); }
                await prune(tx, accountId, taskId);
                return { accountId, task, run };
            }); emit(change);
        },
    };
}
