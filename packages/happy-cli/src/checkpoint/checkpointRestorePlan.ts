import { readCheckpointRetentionBoundary } from './checkpointRetentionBoundary';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { observeCheckpointOperation, type CheckpointOperationObserver } from './checkpointObservability';
import { checkpointCoverageMatcher, checkpointExclusionMatcher } from './checkpointCoverage';
import {
    CheckpointLedger,
    type CheckpointLedgerBinding,
    type CheckpointLedgerRecord,
} from './checkpointLedger';
import {
    checkpointOperationRefPrefix,
    checkpointPinRefPrefix,
    CheckpointStore,
    resolveCheckpointStoreLayout,
    type CheckpointSnapshotRequest,
    type CheckpointSnapshotResult,
} from './checkpointStore';

export type CheckpointRestorePlanEntry =
    | { path: string; action: 'restore'; reason: 'agent-modified' | 'agent-deleted' }
    | { path: string; action: 'delete'; reason: 'agent-created' }
    | { path: string; action: 'skip'; reason: 'user-modified' | 'provenance-unknown' }
    | { path: string; action: 'conflict'; reason: 'unsupported-file-type' | 'unsafe-path' };

export type CheckpointRestorePlanRequest = CheckpointLedgerBinding & {
    checkpointId: string;
    excludedPaths?: string[];
    excludedPatterns?: string[];
    /** specs/checkpoint-local-history R4 — files changed after the last record the user chose to restore. */
    includePaths?: string[];
};

export type CheckpointRestorePlan = {
    checkpointId: string;
    entries: CheckpointRestorePlanEntry[];
};

/**
 * Why a local-history entry is skipped. Kept beside the plan, not in its entries: a Desktop that
 * does not know these values echoes the entries back, and the plan must still match.
 */
export type CheckpointRestoreSkipDetail = {
    path: string;
    detail: 'changed-after-record' | 'not-recorded';
};

type PlanContext = {
    records: Map<string, CheckpointLedgerRecord>;
    coverage: ((path: string) => boolean) | null;
    currentExcludes: (path: string) => boolean;
    /**
     * When the target was made by local history: the binding's latest record, and the paths that
     * changed outside this conversation's turns after the target (first seen in a `before` or
     * `safety` record).
     */
    localHistory: { latestId: string; includePaths: Set<string>; changedOutsideTurns: () => Promise<Set<string>> } | null;
};

const LOCAL_HISTORY_MARKER = 'saycode-local-history-v1';

type CurrentFileState =
    | { kind: 'missing' }
    | { kind: 'regular'; contentHash: string }
    | { kind: 'unsupported'; reason: 'unsupported-file-type' | 'unsafe-path' };

class UnsupportedCheckpointTargetError extends Error {}

export class CheckpointRestorePlanner {
    private readonly checkpointRoot: string;
    private readonly observer: CheckpointOperationObserver | undefined;

    constructor(checkpointRoot: string, options: { observer?: CheckpointOperationObserver } = {}) {
        this.checkpointRoot = resolve(checkpointRoot);
        this.observer = options.observer;
    }

    checkpointBeforeRestore(
        request: CheckpointSnapshotRequest,
    ): Promise<CheckpointSnapshotResult> {
        return new CheckpointStore(this.checkpointRoot, { observer: this.observer }).snapshotTurn(request);
    }

    plan(request: CheckpointRestorePlanRequest): Promise<CheckpointRestorePlan> {
        return this.planWithDetails(request).then(({ plan }) => plan);
    }

    planWithDetails(
        request: CheckpointRestorePlanRequest,
    ): Promise<{ plan: CheckpointRestorePlan; details: CheckpointRestoreSkipDetail[] }> {
        return observeCheckpointOperation(
            'plan',
            () => this.createPlan(request),
            ({ plan }) => summarizePlan(plan),
            { observer: this.observer },
        );
    }

    private async createPlan(
        request: CheckpointRestorePlanRequest,
    ): Promise<{ plan: CheckpointRestorePlan; details: CheckpointRestoreSkipDetail[] }> {
        validateCheckpointId(request.checkpointId);
        const projectPath = await realpath(request.projectPath);
        const context = await this.planContext(request, projectPath);
        const changedPaths = await this.listChangedPaths(request, projectPath);
        for (const path of context.records.keys()) changedPaths.add(path);
        const entries: CheckpointRestorePlanEntry[] = [];
        const details: CheckpointRestoreSkipDetail[] = [];

        for (const path of [...changedPaths].sort()) {
            const planned = await this.entryFor(request, projectPath, path, context);
            if (!planned) continue;
            entries.push(planned.entry);
            if (planned.detail) details.push({ path, detail: planned.detail });
        }

        return { plan: { checkpointId: request.checkpointId, entries }, details };
    }

    async matchesCurrentEntry(
        request: CheckpointRestorePlanRequest,
        expected: CheckpointRestorePlanEntry,
    ): Promise<boolean> {
        validateCheckpointId(request.checkpointId);
        const projectPath = await realpath(request.projectPath);
        const context = await this.planContext(request, projectPath);
        const planned = await this.entryFor(request, projectPath, expected.path, context);
        if (!planned || planned.entry.action === 'skip' || planned.entry.action === 'conflict') return false;
        return JSON.stringify(planned.entry) === JSON.stringify(expected);
    }

    private async planContext(request: CheckpointRestorePlanRequest, projectPath: string): Promise<PlanContext> {
        const records = await new CheckpointLedger(this.checkpointRoot).readRecords({ ...request, projectPath });
        await this.assertCheckpointOwnedByBinding(request, projectPath);
        const body = await this.readCoverage(request, projectPath);
        const layout = resolveCheckpointStoreLayout({ checkpointRoot: this.checkpointRoot, ...request });
        return {
            records: new Map(records.map((record) => [record.path, record])),
            coverage: checkpointCoverageMatcher(body),
            currentExcludes: checkpointExclusionMatcher(request),
            localHistory: body.split('\n').includes(LOCAL_HISTORY_MARKER)
                ? {
                    latestId: (await runGit(['rev-parse', '--verify', `${layout.refName}^{commit}`], projectPath,
                        checkpointGitEnvironment(layout.gitDirectory))).toString('utf8').trim(),
                    includePaths: new Set(request.includePaths ?? []),
                    changedOutsideTurns: once(() => this.changedOutsideTurns(request, projectPath)),
                }
                : null,
        };
    }

    /**
     * Records are independent commits; the binding's operation refs and their record times give
     * their order. Walking from the target, a change that first shows up in a `before` or `safety`
     * record happened between turns, so it is someone else's.
     */
    private async changedOutsideTurns(request: CheckpointRestorePlanRequest, projectPath: string): Promise<Set<string>> {
        const layout = resolveCheckpointStoreLayout({ checkpointRoot: this.checkpointRoot, ...request });
        const environment = checkpointGitEnvironment(layout.gitDirectory);
        const ids = [...new Set((await runGit(['for-each-ref', '--format=%(objectname)', checkpointOperationRefPrefix(layout)],
            projectPath, environment)).toString('utf8').split('\n').filter(Boolean))];
        if (ids.length === 0) return new Set();
        const records = (await runGit(['log', '--no-walk=unsorted', '--format=%H%x00%s%x00%b%x01', ...ids], projectPath, environment))
            .toString('utf8').split('\x01').map((chunk) => chunk.trim()).filter(Boolean).map((chunk) => {
                const [id, subject, body] = chunk.split('\0');
                return {
                    id: id!,
                    createdAt: Number(subject?.match(/^saycode-checkpoint-v1 (\d+)$/)?.[1] ?? Number.NaN),
                    kind: body?.match(/^saycode-record (\w+)$/m)?.[1] ?? null,
                };
            })
            .filter((record) => Number.isFinite(record.createdAt))
            .sort((left, right) => left.createdAt - right.createdAt);
        const start = records.findIndex((record) => record.id === request.checkpointId);
        const changed = new Set<string>();
        if (start < 0) return changed;
        const key = layout.refName.slice(layout.refName.lastIndexOf('/') + 1);
        const boundary = await readCheckpointRetentionBoundary(layout.gitDirectory, key);
        if (boundary !== null && records[start]!.createdAt < boundary) {
            // Without the intervening records we cannot attribute changes to this conversation.
            const latest = records[records.length - 1]!;
            const diff = await runGit(['diff', '--name-only', '-z', request.checkpointId, latest.id], projectPath, environment);
            return new Set(parseNullTerminatedPaths(diff));
        }
        for (let index = start + 1; index < records.length; index += 1) {
            const record = records[index]!;
            if (record.kind === 'after' || record.kind === 'restored') continue;
            const diff = await runGit(['diff', '--name-only', '-z', records[index - 1]!.id, record.id], projectPath, environment);
            for (const path of parseNullTerminatedPaths(diff)) changed.add(path);
        }
        return changed;
    }

    private async entryFor(
        request: CheckpointRestorePlanRequest,
        projectPath: string,
        path: string,
        context: PlanContext,
    ): Promise<{ entry: CheckpointRestorePlanEntry; detail?: CheckpointRestoreSkipDetail['detail'] } | null> {
        const current = await readCurrentFileState(projectPath, path);
        let targetHash: string | null;
        let latestHash: string | null = null;
        try {
            targetHash = current.kind === 'unsupported' ? null : await this.readCheckpointFileHash(request, path, projectPath);
            if (context.localHistory && current.kind !== 'unsupported') {
                latestHash = await this.readCheckpointFileHash({ ...request, checkpointId: context.localHistory.latestId }, path, projectPath);
            }
        } catch (error) {
            if (!(error instanceof UnsupportedCheckpointTargetError)) throw error;
            return { entry: { path, action: 'conflict', reason: 'unsafe-path' } };
        }
        const excluded = context.coverage?.(path) ?? null;
        if (excluded === true || (excluded === null && targetHash === null) || context.currentExcludes(path)) {
            return { entry: { path, action: 'skip', reason: 'provenance-unknown' }, ...(context.localHistory ? { detail: 'not-recorded' as const } : {}) };
        }
        if (!context.localHistory) {
            const entry = createPlanEntry(path, context.records.get(path), current, targetHash);
            return entry ? { entry } : null;
        }
        const included = context.localHistory.includePaths.has(path);
        // Only a file this conversation's turns could have left needs the record walk.
        const unchangedSinceRecord = current.kind === 'missing' ? latestHash === null
            : current.kind === 'regular' && current.contentHash === latestHash;
        const outside = unchangedSinceRecord && !included && (await context.localHistory.changedOutsideTurns()).has(path);
        return localHistoryEntry(path, current, targetHash, latestHash, included, outside);
    }

    async matchesTargetHash(projectPath: string, path: string, expectedHash: string | null): Promise<boolean> {
        const current = await readCurrentFileState(projectPath, path);
        return expectedHash === null ? current.kind === 'missing'
            : current.kind === 'regular' && current.contentHash === expectedHash;
    }

    private async readCoverage(request: CheckpointRestorePlanRequest, projectPath: string): Promise<string> {
        const layout = resolveCheckpointStoreLayout({ checkpointRoot: this.checkpointRoot, ...request });
        return (await runGit(['show', '-s', '--format=%b', request.checkpointId], projectPath,
            checkpointGitEnvironment(layout.gitDirectory))).toString('utf8');
    }

    private async assertCheckpointOwnedByBinding(
        request: CheckpointRestorePlanRequest,
        projectPath: string,
    ): Promise<void> {
        const layout = resolveCheckpointStoreLayout({
            checkpointRoot: this.checkpointRoot,
            sessionId: request.sessionId,
            projectId: request.projectId,
            worktreeId: request.worktreeId,
        });
        const ownedRefs = await runGit([
            'for-each-ref',
            '--format=%(refname)',
            `--points-at=${request.checkpointId}`,
            checkpointOperationRefPrefix(layout),
            checkpointPinRefPrefix(layout),
        ], projectPath, checkpointGitEnvironment(layout.gitDirectory));
        if (ownedRefs.toString('utf8').trim().length > 0) return;
        const containingRef = await runGit([
            'for-each-ref',
            '--format=%(refname)',
            `--contains=${request.checkpointId}`,
            layout.refName,
        ], projectPath, checkpointGitEnvironment(layout.gitDirectory));
        if (containingRef.toString('utf8').trim() !== layout.refName) {
            throw new Error('checkpoint restore target does not belong to binding');
        }
    }

    private async listChangedPaths(
        request: CheckpointRestorePlanRequest,
        projectPath: string,
    ): Promise<Set<string>> {
        const layout = resolveCheckpointStoreLayout({
            checkpointRoot: this.checkpointRoot,
            sessionId: request.sessionId,
            projectId: request.projectId,
            worktreeId: request.worktreeId,
        });
        const indexesDirectory = join(layout.gitDirectory, 'restore-indexes');
        await mkdir(indexesDirectory, { recursive: true });
        const temporaryDirectory = await mkdtemp(join(indexesDirectory, 'plan-'));
        try {
            const environment = checkpointGitEnvironment(
                layout.gitDirectory,
                projectPath,
                join(temporaryDirectory, 'index'),
            );
            await runGit(['read-tree', request.checkpointId], projectPath, environment);
            const [tracked, untracked] = await Promise.all([
                runGit(['diff', '--name-only', '-z', request.checkpointId, '--'], projectPath, environment),
                runGit(['ls-files', '--others', '--exclude-standard', '-z'], projectPath, environment),
            ]);
            return new Set([...parseNullTerminatedPaths(tracked), ...parseNullTerminatedPaths(untracked)]);
        } finally {
            await rm(temporaryDirectory, { recursive: true, force: true });
        }
    }

    async readCheckpointFileHash(
        request: CheckpointRestorePlanRequest,
        path: string,
        projectPath: string,
    ): Promise<string | null> {
        const layout = resolveCheckpointStoreLayout({
            checkpointRoot: this.checkpointRoot,
            sessionId: request.sessionId,
            projectId: request.projectId,
            worktreeId: request.worktreeId,
        });
        const environment = checkpointGitEnvironment(layout.gitDirectory);
        const treeEntry = await runGit([
            'ls-tree',
            '-z',
            request.checkpointId,
            '--',
            `:(top,literal)${path}`,
        ], projectPath, environment);
        if (treeEntry.length === 0) return null;
        const separator = treeEntry.indexOf(0x09);
        if (separator < 0) {
            throw new Error('checkpoint restore target contains an unsupported entry');
        }
        const header = treeEntry.subarray(0, separator).toString('utf8').split(' ');
        if (header.length !== 3 || header[1] !== 'blob') {
            throw new Error('checkpoint restore target contains an unsupported entry');
        }
        if (header[0] !== '100644' && header[0] !== '100755') throw new UnsupportedCheckpointTargetError();
        const contents = await runGit(['cat-file', 'blob', header[2]], projectPath, environment);
        return createHash('sha256').update(contents).digest('hex');
    }
}

function once<T>(load: () => Promise<T>): () => Promise<T> {
    let value: Promise<T> | null = null;
    return () => (value ??= load());
}

function summarizePlan(plan: CheckpointRestorePlan) {
    const counts = { restore: 0, delete: 0, skip: 0, conflict: 0 };
    for (const entry of plan.entries) counts[entry.action] += 1;
    return { files: plan.entries.length, ...counts };
}

/**
 * specs/checkpoint-local-history R4 — a file that still matches this binding's latest record was
 * left by its turns and is restored; one changed since is kept unless the user included it.
 */
function localHistoryEntry(
    path: string,
    current: CurrentFileState,
    targetHash: string | null,
    latestHash: string | null,
    included: boolean,
    changedOutsideTurns: boolean,
): { entry: CheckpointRestorePlanEntry; detail?: CheckpointRestoreSkipDetail['detail'] } | null {
    if (current.kind === 'regular' && current.contentHash === targetHash) return null;
    if (current.kind === 'missing' && targetHash === null) return null;
    if (current.kind === 'unsupported') return { entry: { path, action: 'conflict', reason: current.reason } };
    const unchangedSinceRecord = current.kind === 'missing'
        ? latestHash === null
        : current.contentHash === latestHash;
    if ((!unchangedSinceRecord || changedOutsideTurns) && !included) {
        return { entry: { path, action: 'skip', reason: 'user-modified' }, detail: 'changed-after-record' };
    }
    if (targetHash === null) return { entry: { path, action: 'delete', reason: 'agent-created' } };
    return current.kind === 'missing'
        ? { entry: { path, action: 'restore', reason: 'agent-deleted' } }
        : { entry: { path, action: 'restore', reason: 'agent-modified' } };
}

function createPlanEntry(
    path: string,
    record: CheckpointLedgerRecord | undefined,
    current: CurrentFileState,
    targetHash: string | null,
): CheckpointRestorePlanEntry | null {
    if (!record) return { path, action: 'skip', reason: 'provenance-unknown' };
    if (current.kind === 'regular' && current.contentHash === targetHash) return null;
    if (current.kind === 'missing' && targetHash === null) return null;
    if (current.kind === 'unsupported') {
        return { path, action: 'conflict', reason: current.reason };
    }
    if (record.action === 'written' && current.kind === 'regular') {
        if (current.contentHash !== record.contentHash) {
            return { path, action: 'skip', reason: 'user-modified' };
        }
        return targetHash === null
            ? { path, action: 'delete', reason: 'agent-created' }
            : { path, action: 'restore', reason: 'agent-modified' };
    }
    if (record.action === 'deleted' && current.kind === 'missing' && targetHash !== null) {
        return { path, action: 'restore', reason: 'agent-deleted' };
    }
    return { path, action: 'skip', reason: 'user-modified' };
}

function validateCheckpointId(checkpointId: string): void {
    if (!/^[a-f0-9]{40,64}$/.test(checkpointId)) {
        throw new Error('checkpoint restore target is invalid');
    }
}

async function readCurrentFileState(
    projectPath: string,
    path: string,
): Promise<CurrentFileState> {
    const segments = path.split('/');
    if (
        segments.length === 0
        || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    ) {
        return { kind: 'unsupported', reason: 'unsafe-path' };
    }
    let currentPath = projectPath;
    for (const segment of segments.slice(0, -1)) {
        currentPath = join(currentPath, segment);
        const parent = await lstatOrMissing(currentPath);
        if (parent === null) return { kind: 'missing' };
        if (parent.isSymbolicLink()) return { kind: 'unsupported', reason: 'unsafe-path' };
        if (!parent.isDirectory()) {
            return { kind: 'unsupported', reason: 'unsupported-file-type' };
        }
    }
    const absolutePath = join(currentPath, segments.at(-1)!);
    const stats = await lstatOrMissing(absolutePath);
    if (stats === null) return { kind: 'missing' };
    if (stats.isSymbolicLink()) return { kind: 'unsupported', reason: 'unsafe-path' };
    if (!stats.isFile()) return { kind: 'unsupported', reason: 'unsupported-file-type' };
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(absolutePath)) hash.update(chunk);
    return { kind: 'regular', contentHash: hash.digest('hex') };
}

async function lstatOrMissing(path: string): Promise<Stats | null> {
    let stats;
    try {
        stats = await lstat(path);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
    return stats;
}

function checkpointGitEnvironment(
    gitDirectory: string,
    projectPath?: string,
    indexFile?: string,
): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_DIR: gitDirectory,
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
    };
    if (projectPath) environment.GIT_WORK_TREE = projectPath;
    else delete environment.GIT_WORK_TREE;
    if (indexFile) environment.GIT_INDEX_FILE = indexFile;
    else delete environment.GIT_INDEX_FILE;
    delete environment.GIT_NAMESPACE;
    delete environment.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    return environment;
}

function parseNullTerminatedPaths(output: Buffer): string[] {
    return output.toString('utf8').split('\0').filter((path) => path.length > 0);
}

function runGit(
    args: string[],
    cwd: string,
    environment: NodeJS.ProcessEnv,
): Promise<Buffer> {
    return new Promise((resolvePromise, rejectPromise) => {
        execFile('git', args, {
            cwd,
            env: environment,
            encoding: 'buffer',
            maxBuffer: 10 * 1024 * 1024,
            timeout: 60_000,
        }, (error, stdout, stderr) => {
            if (error) {
                rejectPromise(new Error(`git ${args[0]} failed: ${stderr || error.message}`));
                return;
            }
            resolvePromise(stdout);
        });
    });
}
