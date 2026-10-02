import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, type Stats } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rename, rm, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ignore from 'ignore';
import { CheckpointLedger } from './checkpointLedger';
import {
    checkpointTurnApplyJournalPath,
    checkpointTurnApplyRequestFingerprint,
    createCheckpointTurnApplyJournal,
    readCheckpointTurnApplyJournal,
    writeCheckpointTurnApplyJournal,
} from './checkpointTurnApplyJournal';
import { assertCheckpointOwnedByBinding, CheckpointTurnWorkspace } from './checkpointTurnWorkspace';
import { resolveCheckpointStoreLayout, type CheckpointStoreBinding } from './checkpointStore';

export type CheckpointTurnApplyRequest = Omit<CheckpointStoreBinding, 'checkpointRoot'> & {
    operationId: string;
    checkpointId: string;
    projectPath: string;
    workspacePath: string;
    excludedPaths?: string[];
    excludedPatterns?: string[];
    readOnlyPassthroughPaths?: string[];
};

export type CheckpointTurnApplyPlanEntry =
    | { path: string; action: 'write' | 'delete'; reason: 'agent-modified' | 'agent-created' | 'agent-deleted' }
    | { path: string; action: 'conflict'; reason: 'user-modified' | 'unsafe-path' | 'unsupported-file-type' | 'excluded-path' };

export type CheckpointTurnApplyPlan = {
    checkpointId: string;
    entries: CheckpointTurnApplyPlanEntry[];
};

export type CheckpointTurnApplyResult = {
    status: 'completed' | 'partial';
    entries: Array<{
        path: string;
        action: CheckpointTurnApplyPlanEntry['action'];
        outcome: 'written' | 'deleted' | 'conflict' | 'failed';
        failureCode?: 'mutation-failed' | 'mutation-outcome-unknown';
    }>;
};

type ActionableTurnApplyEntry = Extract<CheckpointTurnApplyPlanEntry, { action: 'write' | 'delete' }>;

export type CheckpointTurnMutation = {
    entry: ActionableTurnApplyEntry;
    apply: () => Promise<void>;
};

export type CheckpointTurnApplierOptions = {
    mutate?: (mutation: CheckpointTurnMutation) => Promise<void>;
};

type FileState =
    | { kind: 'missing' }
    | { kind: 'regular'; contentHash: string }
    | { kind: 'unsupported'; reason: 'unsafe-path' | 'unsupported-file-type' };

export class CheckpointTurnApplier {
    private readonly checkpointRoot: string;
    private readonly mutate: (mutation: CheckpointTurnMutation) => Promise<void>;

    constructor(checkpointRoot: string, options: CheckpointTurnApplierOptions = {}) {
        this.checkpointRoot = resolve(checkpointRoot);
        this.mutate = options.mutate ?? ((mutation) => mutation.apply());
    }

    async execute(request: CheckpointTurnApplyRequest): Promise<CheckpointTurnApplyResult> {
        const projectPath = await realpath(request.projectPath);
        const workspacePath = await this.resolveOwnedWorkspace(request);
        const layout = resolveCheckpointStoreLayout({
            checkpointRoot: this.checkpointRoot,
            sessionId: request.sessionId,
            projectId: request.projectId,
            worktreeId: request.worktreeId,
        });
        await assertCheckpointOwnedByBinding(layout.gitDirectory, layout.refName, request.checkpointId);
        const journalFile = checkpointTurnApplyJournalPath(layout, request.operationId);
        const requestFingerprint = checkpointTurnApplyRequestFingerprint({
            sessionId: request.sessionId,
            projectId: request.projectId,
            worktreeId: request.worktreeId,
            operationId: request.operationId,
            checkpointId: request.checkpointId,
            projectPath,
            workspacePath,
            excludedPaths: request.excludedPaths ?? [],
            excludedPatterns: request.excludedPatterns ?? [],
            readOnlyPassthroughPaths: request.readOnlyPassthroughPaths ?? [],
        });
        let journal = await readCheckpointTurnApplyJournal(journalFile);
        if (journal && journal.requestFingerprint !== requestFingerprint) {
            throw new Error('checkpoint turn apply idempotency key conflict');
        }
        if (!journal) {
            const plan = await this.plan(request);
            journal = createCheckpointTurnApplyJournal(
                requestFingerprint,
                request.checkpointId,
                plan.entries,
            );
            await writeCheckpointTurnApplyJournal(journalFile, journal);
        }
        const ledger = new CheckpointLedger(this.checkpointRoot);
        const results: CheckpointTurnApplyResult['entries'] = [];

        for (const journalEntry of journal.entries) {
            if (journalEntry.action === 'conflict') {
                results.push({ path: journalEntry.path, action: 'conflict', outcome: 'conflict' });
                continue;
            }
            if (journalEntry.outcome === 'applying') {
                results.push({
                    path: journalEntry.path,
                    action: journalEntry.action,
                    outcome: 'failed',
                    failureCode: 'mutation-outcome-unknown',
                });
                continue;
            }
            if (journalEntry.outcome === 'written' || journalEntry.outcome === 'deleted') {
                results.push({
                    path: journalEntry.path,
                    action: journalEntry.action,
                    outcome: journalEntry.outcome,
                });
                continue;
            }
            const currentEntry = (await this.plan(request)).entries.find(({ path }) => path === journalEntry.path);
            if (
                !currentEntry
                || currentEntry.action === 'conflict'
                || currentEntry.action !== journalEntry.action
            ) {
                results.push({ path: journalEntry.path, action: 'conflict', outcome: 'conflict' });
                continue;
            }
            try {
                journalEntry.outcome = 'applying';
                await writeCheckpointTurnApplyJournal(journalFile, journal);
                await this.mutate({
                    entry: currentEntry,
                    apply: () => currentEntry.action === 'write'
                        ? writeWorkspaceFile(workspacePath, projectPath, currentEntry.path)
                        : deleteProjectFile(projectPath, currentEntry.path),
                });
                await ledger.recordMutation({
                    sessionId: request.sessionId,
                    projectId: request.projectId,
                    worktreeId: request.worktreeId,
                    projectPath,
                    operationId: request.operationId,
                    mutationId: mutationId(currentEntry.path, currentEntry.action),
                    path: currentEntry.path,
                    action: currentEntry.action === 'write' ? 'written' : 'deleted',
                });
                results.push({
                    path: currentEntry.path,
                    action: currentEntry.action,
                    outcome: currentEntry.action === 'write' ? 'written' : 'deleted',
                });
                journalEntry.outcome = currentEntry.action === 'write' ? 'written' : 'deleted';
            } catch {
                results.push({
                    path: journalEntry.path,
                    action: journalEntry.action,
                    outcome: 'failed',
                    failureCode: 'mutation-failed',
                });
                journalEntry.outcome = 'failed';
            }
            await writeCheckpointTurnApplyJournal(journalFile, journal);
        }

        return {
            status: results.some(({ outcome }) => outcome === 'failed') ? 'partial' : 'completed',
            entries: results,
        };
    }

    async plan(request: CheckpointTurnApplyRequest): Promise<CheckpointTurnApplyPlan> {
        validateCheckpointId(request.checkpointId);
        const projectPath = await realpath(request.projectPath);
        const workspacePath = await this.resolveOwnedWorkspace(request);
        const layout = resolveCheckpointStoreLayout({
            checkpointRoot: this.checkpointRoot,
            sessionId: request.sessionId,
            projectId: request.projectId,
            worktreeId: request.worktreeId,
        });
        await assertCheckpointOwnedByBinding(layout.gitDirectory, layout.refName, request.checkpointId);
        const changedPaths = await this.listChangedPaths(request, workspacePath);
        const entries: CheckpointTurnApplyPlanEntry[] = [];
        const excluded = createExcludedPathMatcher(request);

        for (const path of [...changedPaths].sort()) {
            if (excluded(path)) {
                entries.push({ path, action: 'conflict', reason: 'excluded-path' });
                continue;
            }
            const [base, workspace, project] = await Promise.all([
                this.readCheckpointState(request, path, projectPath),
                readFileState(workspacePath, path),
                readFileState(projectPath, path),
            ]);
            const unsupported = [workspace, project].find((state) => state.kind === 'unsupported');
            if (unsupported?.kind === 'unsupported') {
                entries.push({ path, action: 'conflict', reason: unsupported.reason });
                continue;
            }
            if (!sameFileState(project, base)) {
                entries.push({ path, action: 'conflict', reason: 'user-modified' });
                continue;
            }
            if (sameFileState(workspace, base)) continue;
            if (workspace.kind === 'missing') {
                entries.push({ path, action: 'delete', reason: 'agent-deleted' });
            } else if (workspace.kind === 'regular') {
                entries.push({
                    path,
                    action: 'write',
                    reason: base.kind === 'missing' ? 'agent-created' : 'agent-modified',
                });
            }
        }

        return { checkpointId: request.checkpointId, entries };
    }

    private async resolveOwnedWorkspace(request: CheckpointTurnApplyRequest): Promise<string> {
        const expectedPath = new CheckpointTurnWorkspace(this.checkpointRoot).frozenPathFor(request);
        if (resolve(request.workspacePath) !== expectedPath) {
            throw new Error('checkpoint turn workspace binding mismatch');
        }
        const [workspacePath, checkpointRoot] = await Promise.all([
            realpath(request.workspacePath),
            realpath(this.checkpointRoot),
        ]);
        const relativePath = relative(checkpointRoot, workspacePath);
        if (
            relativePath === ''
            || relativePath.startsWith(`..${sep}`)
            || relativePath === '..'
            || isAbsolute(relativePath)
        ) {
            throw new Error('checkpoint turn workspace escaped checkpoint root');
        }
        return workspacePath;
    }

    private async listChangedPaths(
        request: CheckpointTurnApplyRequest,
        workspacePath: string,
    ): Promise<Set<string>> {
        const layout = resolveCheckpointStoreLayout({
            checkpointRoot: this.checkpointRoot,
            sessionId: request.sessionId,
            projectId: request.projectId,
            worktreeId: request.worktreeId,
        });
        const indexesDirectory = join(layout.gitDirectory, 'turn-apply-indexes');
        await mkdir(indexesDirectory, { recursive: true });
        const temporaryDirectory = await mkdtemp(join(indexesDirectory, 'plan-'));
        try {
            const environment = checkpointGitEnvironment(
                layout.gitDirectory,
                workspacePath,
                join(temporaryDirectory, 'index'),
            );
            await runGit(['read-tree', request.checkpointId], workspacePath, environment);
            const [tracked, untracked] = await Promise.all([
                runGit(['diff', '--name-only', '-z', request.checkpointId, '--'], workspacePath, environment),
                runGit([
                    'ls-files',
                    '--others',
                    ...((request.readOnlyPassthroughPaths ?? []).map((path) => `--exclude=${path}`)),
                    '-z',
                ], workspacePath, environment),
            ]);
            return new Set([...parsePaths(tracked), ...parsePaths(untracked)]);
        } finally {
            await rm(temporaryDirectory, { recursive: true, force: true });
        }
    }

    private async readCheckpointState(
        request: CheckpointTurnApplyRequest,
        path: string,
        projectPath: string,
    ): Promise<FileState> {
        const layout = resolveCheckpointStoreLayout({
            checkpointRoot: this.checkpointRoot,
            sessionId: request.sessionId,
            projectId: request.projectId,
            worktreeId: request.worktreeId,
        });
        const entry = await runGit([
            'ls-tree',
            '-z',
            request.checkpointId,
            '--',
            `:(top,literal)${path}`,
        ], projectPath, checkpointGitEnvironment(layout.gitDirectory));
        if (entry.length === 0) return { kind: 'missing' };
        const separator = entry.indexOf(0x09);
        const header = separator < 0
            ? []
            : entry.subarray(0, separator).toString('utf8').split(' ');
        if (header.length !== 3 || header[0] !== '100644' && header[0] !== '100755' || header[1] !== 'blob') {
            return { kind: 'unsupported', reason: 'unsupported-file-type' };
        }
        const contents = await runGit(
            ['cat-file', 'blob', header[2]],
            projectPath,
            checkpointGitEnvironment(layout.gitDirectory),
        );
        return { kind: 'regular', contentHash: createHash('sha256').update(contents).digest('hex') };
    }
}

function createExcludedPathMatcher(request: CheckpointTurnApplyRequest): (path: string) => boolean {
    const excludedPaths = request.excludedPaths ?? [];
    const patternMatcher = ignore().add(request.excludedPatterns ?? []);
    return (path) => excludedPaths.some((excludedPath) => (
        path === excludedPath || path.startsWith(`${excludedPath}/`)
    )) || patternMatcher.ignores(path);
}

function validateCheckpointId(checkpointId: string): void {
    if (!/^[a-f0-9]{40,64}$/.test(checkpointId)) {
        throw new Error('checkpoint turn apply target is invalid');
    }
}

function mutationId(path: string, action: 'write' | 'delete'): string {
    return createHash('sha256').update(JSON.stringify([path, action])).digest('hex');
}

async function writeWorkspaceFile(
    workspacePath: string,
    projectPath: string,
    path: string,
): Promise<void> {
    const sourcePath = await resolveSafeMutationPath(workspacePath, path, false);
    const targetPath = await resolveSafeMutationPath(projectPath, path, true);
    const sourceStats = await lstat(sourcePath);
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
        throw new Error('checkpoint turn write source is unsafe');
    }
    const temporaryPath = join(dirname(targetPath), `.saycode-checkpoint-${randomUUID()}.tmp`);
    try {
        await copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL);
        await chmod(temporaryPath, sourceStats.mode & 0o777);
        await rename(temporaryPath, targetPath);
    } finally {
        await rm(temporaryPath, { force: true });
    }
}

async function deleteProjectFile(projectPath: string, path: string): Promise<void> {
    const targetPath = await resolveSafeMutationPath(projectPath, path, false);
    await unlink(targetPath);
}

async function resolveSafeMutationPath(
    root: string,
    path: string,
    createParents: boolean,
): Promise<string> {
    const segments = path.split('/');
    if (segments.length === 0 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new Error('checkpoint turn mutation path is unsafe');
    }
    let currentPath = root;
    for (const segment of segments.slice(0, -1)) {
        currentPath = join(currentPath, segment);
        let stats = await lstatOrMissing(currentPath);
        if (stats === null && createParents) {
            await mkdir(currentPath).catch((error) => {
                if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
            });
            stats = await lstatOrMissing(currentPath);
        }
        if (stats === null || stats.isSymbolicLink() || !stats.isDirectory()) {
            throw new Error('checkpoint turn mutation path is unsafe');
        }
    }
    const result = join(currentPath, segments.at(-1)!);
    const leaf = await lstatOrMissing(result);
    if (leaf?.isSymbolicLink() || leaf && !leaf.isFile()) {
        throw new Error('checkpoint turn mutation path is unsafe');
    }
    return result;
}

function sameFileState(left: FileState, right: FileState): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === 'regular' && right.kind === 'regular') {
        return left.contentHash === right.contentHash;
    }
    return left.kind === 'missing';
}

async function readFileState(root: string, path: string): Promise<FileState> {
    const segments = path.split('/');
    if (segments.length === 0 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        return { kind: 'unsupported', reason: 'unsafe-path' };
    }
    let currentPath = root;
    for (const segment of segments.slice(0, -1)) {
        currentPath = join(currentPath, segment);
        const parent = await lstatOrMissing(currentPath);
        if (parent === null) return { kind: 'missing' };
        if (parent.isSymbolicLink()) return { kind: 'unsupported', reason: 'unsafe-path' };
        if (!parent.isDirectory()) return { kind: 'unsupported', reason: 'unsupported-file-type' };
    }
    const stats = await lstatOrMissing(join(currentPath, segments.at(-1)!));
    if (stats === null) return { kind: 'missing' };
    if (stats.isSymbolicLink()) return { kind: 'unsupported', reason: 'unsafe-path' };
    if (!stats.isFile()) return { kind: 'unsupported', reason: 'unsupported-file-type' };
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(join(currentPath, segments.at(-1)!))) hash.update(chunk);
    return { kind: 'regular', contentHash: hash.digest('hex') };
}

async function lstatOrMissing(path: string): Promise<Stats | null> {
    try {
        return await lstat(path);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
    }
}

function checkpointGitEnvironment(
    gitDirectory: string,
    workTree?: string,
    indexFile?: string,
): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_DIR: gitDirectory,
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
    };
    if (workTree) environment.GIT_WORK_TREE = workTree;
    else delete environment.GIT_WORK_TREE;
    if (indexFile) environment.GIT_INDEX_FILE = indexFile;
    else delete environment.GIT_INDEX_FILE;
    delete environment.GIT_NAMESPACE;
    delete environment.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    return environment;
}

function parsePaths(output: Buffer): string[] {
    return output.toString('utf8').split('\0').filter(Boolean);
}

function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Buffer> {
    return new Promise((resolvePromise, reject) => {
        execFile('git', args, { cwd, env, encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 }, (error, stdout) => {
            if (error) {
                reject(error);
                return;
            }
            resolvePromise(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
        });
    });
}
