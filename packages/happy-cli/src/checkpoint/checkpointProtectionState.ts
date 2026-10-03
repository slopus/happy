import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { resolveExcludedPathDecision } from './checkpointProtection';
import { resolveCheckpointStoreLayout } from './checkpointStore';
import { CheckpointRefreshRejectedError, checkpointRecoveryRevision, checkpointRecoveryDetailSchema, type CheckpointRecoveryDetail } from './checkpointRecovery';

const identifierSchema = z.string().min(1).max(128).refine(
    (value) => value.trim() === value && !/[\u0000-\u001F\u007F]/.test(value),
);
const projectRelativePathSchema = z.string().min(1).max(4096).refine((value) => (
    !/[\u0000-\u001F\u007F]/.test(value)
    && !/^(?:[A-Za-z]:|[\\/])/.test(value)
    && !value.split(/[\\/]+/).includes('..')
), 'path must be project-relative');
const excludedReasonSchema = z.enum([
    'secret',
    'ignored',
    'too-large',
    'file-limit',
    'total-size-limit',
]);
const pendingDecisionSchema = z.object({
    operationId: identifierSchema,
    source: z.enum(['policy-drift', 'turn-apply']),
    excluded: z.array(z.object({
        path: projectRelativePathSchema,
        reason: excludedReasonSchema,
    }).strict()).max(10_000),
}).strict();
const persistedStateSchema = z.object({
    schemaVersion: z.literal(1),
    sessionId: identifierSchema,
    projectId: identifierSchema,
    worktreeId: identifierSchema.nullable(),
    projectPath: z.string().min(1),
    protection: z.discriminatedUnion('status', [
        z.object({ status: z.literal('protected') }).strict(),
        z.object({
            status: z.literal('unavailable'),
            reason: z.literal('excluded-path'),
        }).strict(),
    ]),
    pendingDecision: pendingDecisionSchema.nullable(),
}).strict();

export type CheckpointPendingDecision = z.infer<typeof pendingDecisionSchema> & {
    diagnostic?: CheckpointRecoveryDetail;
    warnings: {
        partialExecutionPossible: true;
        externalSideEffectsMayRepeat: true;
    };
};

export type CheckpointProtectionDecisionStatus = {
    protection:
        | { status: 'protected' }
        | { status: 'unavailable'; reason: 'excluded-path' };
    pendingDecision: CheckpointPendingDecision | null;
};

type Binding = {
    sessionId: string;
    projectId: string;
    worktreeId: string | null;
    projectPath: string;
};

type ReportPendingRequest = Binding & z.infer<typeof pendingDecisionSchema> & { diagnostic?: CheckpointRecoveryDetail };
type ResolveDecisionRequest = Binding & {
    operationId: string;
    decision: 'cancel' | 'disable-protection';
};

const WARNINGS = {
    partialExecutionPossible: true,
    externalSideEffectsMayRepeat: true,
} as const;

export class CheckpointProtectionStateStore {
    constructor(private readonly checkpointRoot: string) {}

    async read(binding: Binding): Promise<CheckpointProtectionDecisionStatus> {
        const canonical = await canonicalBinding(binding);
        const persisted = await readPersisted(this.stateFile(canonical), canonical);
        const result = publicStatus(persisted);
        if (result.pendingDecision) {
            try {
                const detail = JSON.parse(await readFile(`${this.stateFile(canonical)}.diagnostic`, 'utf8'));
                if (detail.revision === checkpointRecoveryRevision(result.pendingDecision)) {
                    result.pendingDecision.diagnostic = checkpointRecoveryDetailSchema.parse(detail.diagnostic);
                }
            } catch {}
        }
        return result;
    }

    async reportPending(request: ReportPendingRequest): Promise<CheckpointProtectionDecisionStatus> {
        const canonical = await canonicalBinding(request);
        const pendingDecision = pendingDecisionSchema.parse({
            operationId: request.operationId,
            source: request.source,
            excluded: request.excluded,
        });
        assertUniquePaths(pendingDecision.excluded);
        const status = await this.update(canonical, (current) => current.protection.status === 'unavailable'
            ? current
            : {
                ...current,
                pendingDecision: {
                    ...pendingDecision,
                    excluded: [...pendingDecision.excluded]
                        .sort((left, right) => left.path.localeCompare(right.path)),
                },
            });
        if (request.diagnostic && status.pendingDecision?.operationId === request.operationId) {
            await writeAtomic(`${this.stateFile(canonical)}.diagnostic`, {
                revision: checkpointRecoveryRevision(status.pendingDecision),
                diagnostic: checkpointRecoveryDetailSchema.parse(request.diagnostic),
            });
        }
        return status;
    }

    /** specs/checkpoint-local-history R5 — drops a decision an older runtime left; protection is kept. */
    async clearPending(binding: Binding): Promise<CheckpointProtectionDecisionStatus> {
        const canonical = await canonicalBinding(binding);
        return this.update(canonical, (current) => ({ ...current, pendingDecision: null }));
    }

    async resolveDecision(request: ResolveDecisionRequest): Promise<CheckpointProtectionDecisionStatus> {
        identifierSchema.parse(request.operationId);
        z.enum(['cancel', 'disable-protection']).parse(request.decision);
        const canonical = await canonicalBinding(request);
        return this.update(canonical, (current) => {
            if (current.pendingDecision?.operationId !== request.operationId) {
                throw new Error('checkpoint pending operation mismatch');
            }
            const resolved = resolveExcludedPathDecision(request.decision);
            return {
                ...current,
                protection: resolved.protection,
                pendingDecision: null,
            };
        });
    }

    async refreshPending(
        request: Binding & { operationId: string; revision: string; requestId: string },
        restart: () => Promise<void>,
    ): Promise<'refreshed' | 'outcome-unknown'> {
        identifierSchema.parse(request.requestId);
        const canonical = await canonicalBinding(request);
        const stateFile = this.stateFile(canonical);
        const journalFile = `${stateFile}.refresh`;
        const journalSchema = z.object({
                schemaVersion: z.literal(1), operationId: identifierSchema,
                requestId: identifierSchema, revision: z.string().regex(/^[a-f0-9]{64}$/),
                status: z.enum(['prepared', 'completed', 'failed']),
                ownerPid: z.number().int().positive().optional(), restartSettled: z.boolean().optional(),
            }).strict();
        const prepared = { schemaVersion: 1, operationId: request.operationId, revision: request.revision,
            requestId: request.requestId, status: 'prepared', ownerPid: process.pid, restartSettled: false };
        const outcome = await withFileLock<'refreshed' | 'outcome-unknown' | 'start'>(`${stateFile}.lock`, async () => {
            let journal: z.infer<typeof journalSchema> | null = null;
            try {
                journal = journalSchema.parse(JSON.parse(await readFile(journalFile, 'utf8')));
            } catch (error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
            }
            const current = await readPersisted(stateFile, canonical);
            if (journal?.requestId === request.requestId) {
                if (journal.operationId !== request.operationId || journal.revision !== request.revision) {
                    throw new Error('checkpoint refresh request mismatch');
                }
                if (journal.status === 'prepared') return 'outcome-unknown';
                if (journal.status === 'completed') {
                    if (current.pendingDecision?.operationId === request.operationId
                        && checkpointRecoveryRevision({ ...current.pendingDecision, warnings: WARNINGS }) === request.revision) {
                        await writeAtomic(stateFile, { ...current, pendingDecision: null });
                    }
                    return 'refreshed';
                }
            }
            const pending = current.pendingDecision;
            if (current.protection.status !== 'protected' || !pending
                || pending.operationId !== request.operationId
                || checkpointRecoveryRevision({ ...pending, warnings: WARNINGS }) !== request.revision) {
                throw new Error('checkpoint recovery revision mismatch');
            }
            if (pending.source !== 'policy-drift') throw new Error('checkpoint excluded write requires explicit cancellation');
            if (journal?.status === 'prepared' && (journal.operationId === request.operationId
                || (!journal.restartSettled && (journal.ownerPid === undefined || isProcessAlive(journal.ownerPid))))) {
                return 'outcome-unknown';
            }
            await writeAtomic(journalFile, prepared);
            return 'start';
        });
        if (outcome !== 'start') return outcome;
        try {
            await restart();
        } catch (error) {
            await withFileLock(`${stateFile}.lock`, () => writeAtomic(journalFile, { ...prepared,
                status: error instanceof CheckpointRefreshRejectedError ? 'failed' : 'prepared', restartSettled: true }));
            throw error;
        }
        return withFileLock<'refreshed'>(`${stateFile}.lock`, async () => {
            const current = await readPersisted(stateFile, canonical);
            await writeAtomic(journalFile, { ...prepared, status: 'completed', restartSettled: true });
            if (current.pendingDecision?.operationId === request.operationId
                && checkpointRecoveryRevision({ ...current.pendingDecision, warnings: WARNINGS }) === request.revision) {
                await writeAtomic(stateFile, { ...current, pendingDecision: null });
            }
            return 'refreshed';
        });
    }

    private stateFile(binding: Binding): string {
        const layout = resolveCheckpointStoreLayout({
            checkpointRoot: this.checkpointRoot,
            sessionId: binding.sessionId,
            projectId: binding.projectId,
            worktreeId: binding.worktreeId,
        });
        return join(layout.gitDirectory, 'protection', basename(layout.metadataFile));
    }

    private async update(
        binding: Binding,
        change: (current: z.infer<typeof persistedStateSchema>) => z.infer<typeof persistedStateSchema>,
    ): Promise<CheckpointProtectionDecisionStatus> {
        const stateFile = this.stateFile(binding);
        return withFileLock(`${stateFile}.lock`, async () => {
            const current = await readPersisted(stateFile, binding);
            const next = persistedStateSchema.parse(change(current));
            await writeAtomic(stateFile, next);
            return publicStatus(next);
        });
    }
}

async function canonicalBinding(binding: Binding): Promise<Binding> {
    return {
        sessionId: identifierSchema.parse(binding.sessionId),
        projectId: identifierSchema.parse(binding.projectId),
        worktreeId: binding.worktreeId === null ? null : identifierSchema.parse(binding.worktreeId),
        projectPath: await realpath(binding.projectPath),
    };
}

function initialState(binding: Binding): z.infer<typeof persistedStateSchema> {
    return {
        schemaVersion: 1,
        ...binding,
        protection: { status: 'protected' },
        pendingDecision: null,
    };
}

async function readPersisted(
    stateFile: string,
    binding: Binding,
): Promise<z.infer<typeof persistedStateSchema>> {
    let parsed: z.infer<typeof persistedStateSchema>;
    try {
        parsed = persistedStateSchema.parse(JSON.parse(await readFile(stateFile, 'utf8')));
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return initialState(binding);
        }
        throw error;
    }
    if (
        parsed.sessionId !== binding.sessionId
        || parsed.projectId !== binding.projectId
        || parsed.worktreeId !== binding.worktreeId
        || parsed.projectPath !== binding.projectPath
    ) {
        throw new Error('checkpoint protection state binding mismatch');
    }
    return parsed;
}

function publicStatus(state: z.infer<typeof persistedStateSchema>): CheckpointProtectionDecisionStatus {
    return {
        protection: state.protection,
        pendingDecision: state.pendingDecision
            ? { ...state.pendingDecision, warnings: WARNINGS }
            : null,
    };
}

function assertUniquePaths(excluded: Array<{ path: string }>): void {
    if (new Set(excluded.map((entry) => entry.path)).size !== excluded.length) {
        throw new Error('checkpoint pending excluded paths must be unique');
    }
}

async function writeAtomic(
    stateFile: string,
    state: unknown,
): Promise<void> {
    await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
    const temporaryFile = `${stateFile}.${randomUUID()}.tmp`;
    const handle = await open(temporaryFile, 'wx', 0o600);
    try {
        try {
            await handle.writeFile(JSON.stringify(state));
            await handle.sync();
        } finally {
            await handle.close();
        }
        await rename(temporaryFile, stateFile);
        const directory = await open(dirname(stateFile), 'r');
        try {
            await directory.sync();
        } finally {
            await directory.close();
        }
    } catch (error) {
        await unlink(temporaryFile).catch(() => undefined);
        throw error;
    }
}

function isProcessAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (error) { return !(error instanceof Error && 'code' in error && error.code === 'ESRCH'); }
}

async function withFileLock<T>(lockFile: string, action: () => Promise<T>): Promise<T> {
    await mkdir(dirname(lockFile), { recursive: true, mode: 0o700 });
    const token = randomUUID();
    let lock: Awaited<ReturnType<typeof open>> | null = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
            const candidate = await open(lockFile, 'wx', 0o600);
            try {
                await candidate.writeFile(JSON.stringify({ token, pid: process.pid }));
                await candidate.sync();
                lock = candidate;
            } catch (error) {
                await candidate.close();
                await unlink(lockFile).catch(() => undefined);
                throw error;
            }
            break;
        } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
            const lockStat = await stat(lockFile).catch((statError) => {
                if (statError instanceof Error && 'code' in statError && statError.code === 'ENOENT') return null;
                throw statError;
            });
            if (!lockStat) continue;
            let ownerAlive = true;
            try {
                const owner = JSON.parse(await readFile(lockFile, 'utf8')) as { pid?: unknown };
                if (typeof owner.pid === 'number' && owner.pid > 0 && Number.isSafeInteger(owner.pid)) {
                    ownerAlive = isProcessAlive(owner.pid);
                }
            } catch { ownerAlive = Date.now() - lockStat.mtimeMs <= 30_000; }
            if (!ownerAlive) await unlink(lockFile).catch(() => undefined);
            else await delay(10);
        }
    }
    if (!lock) throw new Error('checkpoint protection state lock timeout');
    try {
        return await action();
    } finally {
        await lock.close();
        const currentToken = await readFile(lockFile, 'utf8').catch(() => null);
        if (currentToken === JSON.stringify({ token, pid: process.pid })) await unlink(lockFile).catch(() => undefined);
    }
}
