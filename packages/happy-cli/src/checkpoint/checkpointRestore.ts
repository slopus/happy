import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CheckpointLedger, type CheckpointLedgerBinding } from './checkpointLedger';
import { withCheckpointPin } from './checkpointGarbageCollector';
import { observeCheckpointOperation, type CheckpointOperationObserver } from './checkpointObservability';
import {
    checkpointRestoreJournalPath,
    checkpointRestoreRequestFingerprint,
    createCheckpointRestoreJournal,
    readCheckpointRestoreJournal,
    writeCheckpointRestoreJournal,
    type CheckpointRestoreJournal,
} from './checkpointRestoreJournal';
import {
    CheckpointRestorePlanner,
    type CheckpointRestorePlan,
    type CheckpointRestorePlanEntry,
} from './checkpointRestorePlan';
import { CheckpointStore, resolveCheckpointStoreLayout } from './checkpointStore';
import { checkpointExclusionMatcher } from './checkpointCoverage';

export type CheckpointRestoreExecuteRequest = CheckpointLedgerBinding & {
    operationId: string;
    plan: CheckpointRestorePlan;
    confirmed: boolean;
    excludedPaths?: string[];
    excludedPatterns?: string[];
    includePaths?: string[];
    /**
     * specs/checkpoint-local-history R4 — the safety checkpoint and a record after the restore are
     * taken the way turns are recorded, so restoring the safety checkpoint undoes this restore.
     */
    localHistory?: { maxFileBytes: number };
};

type CheckpointRestoreEntryResult = {
    path: string;
    action: CheckpointRestorePlanEntry['action'];
    outcome: 'restored' | 'deleted' | 'skipped' | 'conflict' | 'failed';
    failureCode?: 'mutation-failed' | 'mutation-outcome-unknown';
};

export type CheckpointRestoreExecuteResult =
    | { status: 'cancelled' }
    | { status: 'stale-plan' }
    | {
        status: 'completed' | 'partial';
        safetyCheckpointId: string;
        entries: CheckpointRestoreEntryResult[];
    };

type ActionableRestoreEntry = Extract<
    CheckpointRestorePlanEntry,
    { action: 'restore' | 'delete' }
>;

export type CheckpointRestoreMutation = {
    entry: ActionableRestoreEntry;
    apply: () => Promise<void>;
};

export type CheckpointRestoreExecutorOptions = {
    mutate?: (mutation: CheckpointRestoreMutation) => Promise<void>;
    observer?: CheckpointOperationObserver;
};

const restoreExecutionQueues = new Map<string, Promise<void>>();

export class CheckpointRestoreExecutor {
    private readonly checkpointRoot: string;
    private readonly mutate: (mutation: CheckpointRestoreMutation) => Promise<void>;
    private readonly observer: CheckpointOperationObserver | undefined;

    constructor(checkpointRoot: string, options: CheckpointRestoreExecutorOptions = {}) {
        this.checkpointRoot = resolve(checkpointRoot);
        this.mutate = options.mutate ?? ((mutation) => mutation.apply());
        this.observer = options.observer;
    }

    execute(
        request: CheckpointRestoreExecuteRequest,
    ): Promise<CheckpointRestoreExecuteResult> {
        return observeCheckpointOperation(
            'restore',
            () => this.executeRequest(request),
            summarizeRestore,
            { observer: this.observer },
        );
    }

    private async executeRequest(
        request: CheckpointRestoreExecuteRequest,
    ): Promise<CheckpointRestoreExecuteResult> {
        if (!request.confirmed) return { status: 'cancelled' };
        validateOperationId(request.operationId);
        const projectPath = await realpath(request.projectPath);
        const layout = resolveCheckpointStoreLayout({
            checkpointRoot: this.checkpointRoot,
            sessionId: request.sessionId,
            projectId: request.projectId,
            worktreeId: request.worktreeId,
        });
        const journalFile = checkpointRestoreJournalPath(layout, request.operationId);
        return withCheckpointPin(this.checkpointRoot, {
            sessionId: request.sessionId,
            projectId: request.projectId,
            worktreeId: request.worktreeId,
            checkpointId: request.plan.checkpointId,
            operationId: `${request.operationId}:restore-target`,
        }, () => enqueueRestore(projectPath, () => this.executeConfirmed(
            request,
            projectPath,
            journalFile,
        )));
    }

    private async executeConfirmed(
        request: CheckpointRestoreExecuteRequest,
        projectPath: string,
        journalFile: string,
    ): Promise<CheckpointRestoreExecuteResult> {
        const fingerprintInput = {
            sessionId: request.sessionId,
            projectId: request.projectId,
            worktreeId: request.worktreeId,
            operationId: request.operationId,
            projectPath,
            plan: request.plan,
        };
        const requestFingerprint = checkpointRestoreRequestFingerprint(fingerprintInput);
        let journal = await readCheckpointRestoreJournal(journalFile);
        if (journal && journal.requestFingerprint !== requestFingerprint) {
            const legacyFingerprint = checkpointRestoreRequestFingerprint({ ...fingerprintInput,
                excludedPaths: request.excludedPaths ?? [], excludedPatterns: request.excludedPatterns ?? [] });
            if (journal.requestFingerprint !== legacyFingerprint) throw new Error('checkpoint restore idempotency key conflict');
            journal.requestFingerprint = requestFingerprint;
            await writeCheckpointRestoreJournal(journalFile, journal);
        }

        const planner = new CheckpointRestorePlanner(this.checkpointRoot);
        if (!journal) {
            const currentPlan = await planner.plan({
                sessionId: request.sessionId,
                projectId: request.projectId,
                worktreeId: request.worktreeId,
                projectPath,
                checkpointId: request.plan.checkpointId,
                excludedPaths: request.excludedPaths,
                excludedPatterns: request.excludedPatterns,
                includePaths: request.includePaths,
            });
            if (JSON.stringify(currentPlan) !== JSON.stringify(request.plan)) {
                return { status: 'stale-plan' };
            }
            const safety = await planner.checkpointBeforeRestore({
                sessionId: request.sessionId,
                projectId: request.projectId,
                worktreeId: request.worktreeId,
                operationId: safetyOperationId(request.operationId),
                projectPath,
                excludedPaths: request.excludedPaths,
                excludedPatterns: request.excludedPatterns,
                ...(request.localHistory ? { workTree: { ...request.localHistory, record: 'safety' as const } } : {}),
            });
            journal = createCheckpointRestoreJournal(
                requestFingerprint,
                safety.checkpointId,
                currentPlan.entries,
            );
            await writeCheckpointRestoreJournal(journalFile, journal);
        }
        assertJournalMatchesPlan(journal, request.plan);

        const entries = await this.applyPlan(
            request,
            projectPath,
            journalFile,
            journal,
        );
        if (request.localHistory) {
            await new CheckpointStore(this.checkpointRoot).snapshotTurn({
                sessionId: request.sessionId,
                projectId: request.projectId,
                worktreeId: request.worktreeId,
                projectPath,
                operationId: `${safetyOperationId(request.operationId)}:after:${randomUUID()}`,
                excludedPatterns: request.excludedPatterns,
                workTree: { ...request.localHistory, record: 'restored' },
            });
        }
        return {
            status: entries.some((entry) => entry.outcome === 'failed')
                ? 'partial'
                : 'completed',
            safetyCheckpointId: journal.safetyCheckpointId,
            entries,
        };
    }

    private async applyPlan(
        request: CheckpointRestoreExecuteRequest,
        projectPath: string,
        journalFile: string,
        journal: CheckpointRestoreJournal,
    ): Promise<CheckpointRestoreEntryResult[]> {
        const layout = resolveCheckpointStoreLayout({
            checkpointRoot: this.checkpointRoot,
            sessionId: request.sessionId,
            projectId: request.projectId,
            worktreeId: request.worktreeId,
        });
        const hasPendingMutation = journal.entries.some((entry) => (
            (entry.action === 'restore' || entry.action === 'delete')
            && (entry.outcome === 'pending' || entry.outcome === 'failed')
        ));
        if (!hasPendingMutation) return journal.entries.map(toEntryResult);
        const indexesDirectory = join(layout.gitDirectory, 'restore-indexes');
        await mkdir(indexesDirectory, { recursive: true });
        const temporaryDirectory = await mkdtemp(join(indexesDirectory, 'apply-'));
        const environment = checkpointGitEnvironment(
            layout.gitDirectory,
            projectPath,
            join(temporaryDirectory, 'index'),
        );
        try {
            await runGit(['read-tree', request.plan.checkpointId], projectPath, environment);
            for (const [index, journalEntry] of journal.entries.entries()) {
                if (
                    (journalEntry.action !== 'restore' && journalEntry.action !== 'delete')
                    || (journalEntry.outcome !== 'pending' && journalEntry.outcome !== 'failed')
                ) continue;
                const entry = request.plan.entries[index];
                if (!entry || entry.path !== journalEntry.path || entry.action !== journalEntry.action) {
                    throw new Error('checkpoint restore journal does not match plan');
                }
                journalEntry.outcome = 'applying';
                await writeCheckpointRestoreJournal(journalFile, journal);
                try {
                    const expectedContentHash = entry.action === 'restore'
                        ? await new CheckpointRestorePlanner(this.checkpointRoot).readCheckpointFileHash({
                            ...request, checkpointId: request.plan.checkpointId,
                        }, entry.path, projectPath)
                        : null;
                    await prepareSafeMutationPath(
                        projectPath,
                        entry.path,
                        entry.action === 'restore',
                    );
                    await this.mutate({
                        entry,
                        apply: async () => {
                            if (checkpointExclusionMatcher(request)(entry.path)) {
                                throw new Error('checkpoint restore path is currently excluded');
                            }
                            const current = await new CheckpointRestorePlanner(this.checkpointRoot).matchesCurrentEntry({
                                sessionId: request.sessionId,
                                projectId: request.projectId,
                                worktreeId: request.worktreeId,
                                projectPath,
                                checkpointId: request.plan.checkpointId,
                                excludedPaths: request.excludedPaths,
                                excludedPatterns: request.excludedPatterns,
                                includePaths: request.includePaths,
                            }, entry);
                            if (!current && !await new CheckpointRestorePlanner(this.checkpointRoot)
                                .matchesTargetHash(projectPath, entry.path, expectedContentHash)) {
                                throw new Error('checkpoint restore file changed before mutation');
                            }
                            if (current) await applyMutation(entry, projectPath, environment);
                        },
                    });
                    await new CheckpointLedger(this.checkpointRoot).recordMutation({
                        ...request, projectPath,
                        operationId: `restore:${createHash('sha256').update(request.operationId).digest('hex')}`,
                        mutationId: createHash('sha256').update(entry.path).digest('hex'),
                        path: entry.path,
                        action: entry.action === 'restore' ? 'written' : 'deleted',
                        expectedContentHash,
                    });
                    journalEntry.outcome = entry.action === 'restore' ? 'restored' : 'deleted';
                } catch {
                    journalEntry.outcome = 'failed';
                }
                await writeCheckpointRestoreJournal(journalFile, journal);
            }
            return journal.entries.map(toEntryResult);
        } finally {
            await rm(temporaryDirectory, { recursive: true, force: true });
        }
    }
}

function summarizeRestore(result: CheckpointRestoreExecuteResult) {
    const entries = 'entries' in result ? result.entries : [];
    return {
        status: result.status,
        files: entries.length,
        failed: entries.filter((entry) => entry.outcome === 'failed').length,
    };
}

function validateOperationId(operationId: string): void {
    if (
        operationId.length === 0
        || operationId.length > 128
        || operationId.trim() !== operationId
        || /[\u0000-\u001F\u007F]/.test(operationId)
    ) {
        throw new Error('checkpoint restore operation id is invalid');
    }
}

function safetyOperationId(operationId: string): string {
    return `restore-${createHash('sha256').update(operationId).digest('hex')}`;
}

async function prepareSafeMutationPath(
    projectPath: string,
    path: string,
    createParents: boolean,
): Promise<void> {
    const segments = path.split('/');
    if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
        throw new Error('checkpoint restore path is unsafe');
    }
    let currentPath = projectPath;
    for (const segment of segments.slice(0, -1)) {
        currentPath = join(currentPath, segment);
        let stats;
        try {
            stats = await lstat(currentPath);
        } catch (error) {
            if (
                error instanceof Error
                && 'code' in error
                && error.code === 'ENOENT'
            ) {
                if (!createParents) return;
                try {
                    await mkdir(currentPath);
                } catch (mkdirError) {
                    if (!(
                        mkdirError instanceof Error
                        && 'code' in mkdirError
                        && mkdirError.code === 'EEXIST'
                    )) throw mkdirError;
                }
                stats = await lstat(currentPath);
            } else {
                throw error;
            }
        }
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
            throw new Error('checkpoint restore path is unsafe');
        }
    }
}

async function applyMutation(
    entry: ActionableRestoreEntry,
    projectPath: string,
    environment: NodeJS.ProcessEnv,
): Promise<void> {
    if (entry.action === 'restore') {
        await runGit(['checkout-index', '--force', '--', entry.path], projectPath, environment);
        return;
    }
    await unlink(resolve(projectPath, entry.path)).catch((error) => {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    });
}

function toEntryResult(
    entry: CheckpointRestoreJournal['entries'][number],
): CheckpointRestoreEntryResult {
    const { outcome } = entry;
    if (outcome === 'pending') {
        throw new Error('checkpoint restore journal contains an unapplied entry');
    }
    if (outcome === 'applying') {
        return {
            path: entry.path,
            action: entry.action,
            outcome: 'failed',
            failureCode: 'mutation-outcome-unknown',
        };
    }
    return outcome === 'failed'
        ? { path: entry.path, action: entry.action, outcome, failureCode: 'mutation-failed' }
        : { path: entry.path, action: entry.action, outcome };
}

function assertJournalMatchesPlan(
    journal: CheckpointRestoreJournal,
    plan: CheckpointRestorePlan,
): void {
    if (
        journal.entries.length !== plan.entries.length
        || journal.entries.some((entry, index) => (
            entry.path !== plan.entries[index]?.path
            || entry.action !== plan.entries[index]?.action
        ))
    ) {
        throw new Error('checkpoint restore journal does not match plan');
    }
}

function enqueueRestore<T>(projectPath: string, work: () => Promise<T>): Promise<T> {
    const pending = restoreExecutionQueues.get(projectPath) ?? Promise.resolve();
    const result = pending.then(work);
    const next = result.then(() => undefined, () => undefined);
    restoreExecutionQueues.set(projectPath, next);
    void next.then(() => {
        if (restoreExecutionQueues.get(projectPath) === next) {
            restoreExecutionQueues.delete(projectPath);
        }
    });
    return result;
}

function checkpointGitEnvironment(
    gitDirectory: string,
    projectPath: string,
    indexFile: string,
): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_DIR: gitDirectory,
        GIT_WORK_TREE: projectPath,
        GIT_INDEX_FILE: indexFile,
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
    };
    delete environment.GIT_NAMESPACE;
    delete environment.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    return environment;
}

function runGit(
    args: string[],
    cwd: string,
    environment: NodeJS.ProcessEnv,
): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
        execFile('git', args, {
            cwd,
            env: environment,
            maxBuffer: 10 * 1024 * 1024,
            timeout: 60_000,
        }, (error, _stdout, stderr) => {
            if (error) {
                rejectPromise(new Error(`git ${args[0]} failed: ${stderr || error.message}`));
                return;
            }
            resolvePromise();
        });
    });
}
