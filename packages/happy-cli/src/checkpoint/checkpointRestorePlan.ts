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
};

export type CheckpointRestorePlan = {
    checkpointId: string;
    entries: CheckpointRestorePlanEntry[];
};

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
        return observeCheckpointOperation(
            'plan',
            () => this.createPlan(request),
            summarizePlan,
            { observer: this.observer },
        );
    }

    private async createPlan(request: CheckpointRestorePlanRequest): Promise<CheckpointRestorePlan> {
        validateCheckpointId(request.checkpointId);
        const projectPath = await realpath(request.projectPath);
        const records = await new CheckpointLedger(this.checkpointRoot).readRecords({
            ...request,
            projectPath,
        });
        await this.assertCheckpointOwnedByBinding(request, projectPath);
        const latestByPath = new Map(records.map((record) => [record.path, record]));
        const changedPaths = await this.listChangedPaths(request, projectPath);
        for (const path of latestByPath.keys()) changedPaths.add(path);
        const entries: CheckpointRestorePlanEntry[] = [];
        const coverage = checkpointCoverageMatcher(await this.readCoverage(request, projectPath));
        const currentExcludes = checkpointExclusionMatcher(request);

        for (const path of [...changedPaths].sort()) {
            const record = latestByPath.get(path);
            const current = await readCurrentFileState(projectPath, path);
            let targetHash: string | null;
            try { targetHash = current.kind === 'unsupported' ? null : await this.readCheckpointFileHash(request, path, projectPath); }
            catch (error) {
                if (!(error instanceof UnsupportedCheckpointTargetError)) throw error;
                entries.push({ path, action: 'conflict', reason: 'unsafe-path' });
                continue;
            }
            const excluded = coverage?.(path) ?? null;
            const entry: CheckpointRestorePlanEntry | null = excluded === true || (excluded === null && targetHash === null)
                || currentExcludes(path)
                ? { path, action: 'skip', reason: 'provenance-unknown' }
                : createPlanEntry(path, record, current, targetHash);
            if (entry) entries.push(entry);
        }

        return { checkpointId: request.checkpointId, entries };
    }

    async matchesCurrentEntry(
        request: CheckpointRestorePlanRequest,
        expected: CheckpointRestorePlanEntry,
    ): Promise<boolean> {
        validateCheckpointId(request.checkpointId);
        const projectPath = await realpath(request.projectPath);
        const records = await new CheckpointLedger(this.checkpointRoot).readRecords({
            ...request,
            projectPath,
        });
        await this.assertCheckpointOwnedByBinding(request, projectPath);
        let record: CheckpointLedgerRecord | undefined;
        for (let index = records.length - 1; index >= 0; index -= 1) {
            if (records[index]?.path === expected.path) {
                record = records[index];
                break;
            }
        }
        const current = await readCurrentFileState(projectPath, expected.path);
        const targetHash = current.kind === 'unsupported'
            ? null
            : await this.readCheckpointFileHash(request, expected.path, projectPath);
        const excluded = checkpointCoverageMatcher(await this.readCoverage(request, projectPath))?.(expected.path) ?? null;
        if (excluded === true || (excluded === null && targetHash === null)
            || checkpointExclusionMatcher(request)(expected.path)) return false;
        return JSON.stringify(createPlanEntry(expected.path, record, current, targetHash))
            === JSON.stringify(expected);
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

function summarizePlan(plan: CheckpointRestorePlan) {
    const counts = { restore: 0, delete: 0, skip: 0, conflict: 0 };
    for (const entry of plan.entries) counts[entry.action] += 1;
    return { files: plan.entries.length, ...counts };
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
