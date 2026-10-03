import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { observeCheckpointOperation, type CheckpointOperationObserver } from './checkpointObservability';
import { withCheckpointStaging, withCheckpointStoreLock } from './checkpointStoreLock';
import { CheckpointPolicyDriftError, type CheckpointExclusionManifest } from './checkpointExclusionPolicy';
import { checkpointCoverageTrailer } from './checkpointCoverage';

export type CheckpointStoreBinding = {
    checkpointRoot: string;
    sessionId: string;
    projectId: string;
    worktreeId: string | null;
};

export type CheckpointStoreLayout = {
    gitDirectory: string;
    refName: string;
    indexFile: string;
    metadataFile: string;
    ledgerFile: string;
};

export type CheckpointSnapshotRequest = Omit<CheckpointStoreBinding, 'checkpointRoot'> & {
    operationId: string;
    projectPath: string;
    excludedPaths?: string[];
    excludedPatterns?: string[];
    capturedFiles?: CheckpointExclusionManifest['capturedFiles'];
    validateCapture?: () => Promise<void>;
    /**
     * specs/checkpoint-local-history R2 — record the whole folder (ignore rules and excluded patterns
     * applied) through a per-binding index, so a later turn only rehashes what changed. Files over
     * `maxFileBytes` stay unrecorded and are listed in the coverage trailer.
     */
    workTree?: {
        maxFileBytes: number;
        /**
         * What the record marks: a turn's start (`before`) or end (`after`), or a restore's safety
         * point (`safety`) and result (`restored`). Restore planning treats changes that first
         * appear in a `before`/`safety` record as made outside this conversation's turns.
         */
        record?: 'before' | 'after' | 'safety' | 'restored';
    };
};

const LOCAL_HISTORY_MARKER = 'saycode-local-history-v1';
const WORK_TREE_ADD_TIMEOUT_MS = 10 * 60_000;

export type CheckpointSnapshotResult = {
    checkpointId: string;
    created: boolean;
};

type GitResult = {
    stdout: string;
    stderr: string;
    exitCode: number;
};

export function resolveCheckpointStoreLayout(
    binding: CheckpointStoreBinding,
): CheckpointStoreLayout {
    const identityKey = createHash('sha256')
        .update(JSON.stringify([
            binding.sessionId,
            binding.projectId,
            binding.worktreeId,
        ]))
        .digest('hex');
    const gitDirectory = join(resolve(binding.checkpointRoot), 'store');

    return {
        gitDirectory,
        refName: `refs/saycode-checkpoints/${identityKey}`,
        indexFile: join(gitDirectory, 'indexes', identityKey),
        metadataFile: join(gitDirectory, 'bindings', `${identityKey}.json`),
        ledgerFile: join(gitDirectory, 'ledgers', `${identityKey}.jsonl`),
    };
}

export function checkpointOperationRefPrefix(layout: Pick<CheckpointStoreLayout, 'refName'>): string {
    const bindingKey = layout.refName.slice(layout.refName.lastIndexOf('/') + 1);
    return `refs/saycode-checkpoint-operations/${bindingKey}`;
}

export function checkpointPinRefPrefix(layout: Pick<CheckpointStoreLayout, 'refName'>): string {
    const bindingKey = layout.refName.slice(layout.refName.lastIndexOf('/') + 1);
    return `refs/saycode-checkpoint-pins/${bindingKey}`;
}

export function validateCheckpointProjectPath(input: {
    projectPath: string;
    checkpointRoot: string;
    userHomePath: string;
}): void {
    const projectPath = resolve(input.projectPath);
    const checkpointRoot = resolve(input.checkpointRoot);
    const userHomePath = resolve(input.userHomePath);
    if (projectPath === parse(projectPath).root || projectPath === userHomePath) {
        throw new Error('checkpoint project path is too broad');
    }
    if (
        isWithin(projectPath, checkpointRoot)
        || isWithin(checkpointRoot, projectPath)
    ) {
        throw new Error('checkpoint store overlaps project path');
    }
}

function isWithin(parent: string, child: string): boolean {
    const childRelativePath = relative(parent, child);
    return childRelativePath === '' || (
        !childRelativePath.startsWith(`..${sep}`)
        && childRelativePath !== '..'
        && !isAbsolute(childRelativePath)
    );
}

export class CheckpointStore {
    private readonly checkpointRoot: string;
    private readonly observer: CheckpointOperationObserver | undefined;
    private initialization: Promise<void> | null = null;
    private readonly latestOperationByRef = new Map<string, {
        operationId: string;
        snapshot: Promise<CheckpointSnapshotResult>;
    }>();

    constructor(checkpointRoot: string, options: { observer?: CheckpointOperationObserver } = {}) {
        this.checkpointRoot = resolve(checkpointRoot);
        this.observer = options.observer;
    }

    snapshotTurn(request: CheckpointSnapshotRequest): Promise<CheckpointSnapshotResult> {
        const layout = resolveCheckpointStoreLayout({
            checkpointRoot: this.checkpointRoot,
            sessionId: request.sessionId,
            projectId: request.projectId,
            worktreeId: request.worktreeId,
        });
        const current = this.latestOperationByRef.get(layout.refName);
        if (current?.operationId === request.operationId) {
            return current.snapshot;
        }

        const createSnapshot = observeCheckpointOperation(
            'snapshot',
            () => this.createSnapshot(request, layout),
            (result) => ({ created: result.created }),
            { observer: this.observer },
        );
        const snapshot = createSnapshot.then(
            (result) => {
                this.clearInFlightOperation(layout.refName, snapshot);
                return result;
            },
            (error) => {
                this.clearInFlightOperation(layout.refName, snapshot);
                throw error;
            },
        );
        this.latestOperationByRef.set(layout.refName, {
            operationId: request.operationId,
            snapshot,
        });
        return snapshot;
    }

    private clearInFlightOperation(
        refName: string,
        snapshot: Promise<CheckpointSnapshotResult>,
    ): void {
        if (this.latestOperationByRef.get(refName)?.snapshot === snapshot) {
            this.latestOperationByRef.delete(refName);
        }
    }

    private async createSnapshot(
        request: CheckpointSnapshotRequest,
        layout: CheckpointStoreLayout,
    ): Promise<CheckpointSnapshotResult> {
        const projectPath = await realpath(request.projectPath);
        if (!(await stat(projectPath)).isDirectory()) {
            throw new Error('checkpoint project path must be a directory');
        }
        const userHomePath = await realpath(homedir()).catch(() => resolve(homedir()));
        validateCheckpointProjectPath({
            projectPath,
            checkpointRoot: this.checkpointRoot,
            userHomePath,
        });
        await this.ensureInitialized(layout.gitDirectory);
        if (request.workTree) return this.createWorkTreeSnapshot(request, layout, projectPath);
        return withCheckpointStoreLock(this.checkpointRoot, () => this.createSnapshotLocked(
            request,
            layout,
            projectPath,
        ));
    }

    /**
     * A whole-folder record can hash for minutes the first time; it stages outside the store lock
     * and takes it only for the tree, commit and refs. Its index never reads the parent record.
     */
    private async createWorkTreeSnapshot(
        request: CheckpointSnapshotRequest,
        layout: CheckpointStoreLayout,
        projectPath: string,
    ): Promise<CheckpointSnapshotResult> {
        await bindSnapshotFiles(request, layout, projectPath);
        const snapshotLayout = { ...layout, indexFile: `${layout.indexFile}.${randomUUID()}` };
        const environment = this.gitEnvironment(snapshotLayout, projectPath);
        try {
            const completed = await completedSnapshot(request, snapshotLayout, projectPath, environment);
            if (completed) return completed;
            return await withCheckpointStaging(this.checkpointRoot, async () => {
                const staged = await stageSnapshotIndex(request, layout, snapshotLayout, projectPath, environment, null);
                return withCheckpointStoreLock(this.checkpointRoot, async () => {
                    const raced = await completedSnapshot(request, snapshotLayout, projectPath, environment);
                    if (raced) return raced;
                    const parentId = await latestCheckpointId(layout, projectPath, environment);
                    return commitStagedSnapshot(request, layout, snapshotLayout, projectPath, environment, parentId, staged);
                });
            });
        } finally {
            await removeSnapshotFiles(snapshotLayout);
        }
    }

    private async createSnapshotLocked(
        request: CheckpointSnapshotRequest,
        layout: CheckpointStoreLayout,
        projectPath: string,
    ): Promise<CheckpointSnapshotResult> {
        await bindSnapshotFiles(request, layout, projectPath);
        const snapshotLayout = { ...layout, indexFile: `${layout.indexFile}.${randomUUID()}` };
        const environment = this.gitEnvironment(snapshotLayout, projectPath);
        try {
            const completed = await completedSnapshot(request, snapshotLayout, projectPath, environment);
            if (completed) return completed;
            const parentId = await latestCheckpointId(layout, projectPath, environment);
            const staged = await stageSnapshotIndex(request, layout, snapshotLayout, projectPath, environment, parentId);
            return await commitStagedSnapshot(request, layout, snapshotLayout, projectPath, environment, parentId, staged);
        } finally {
            await removeSnapshotFiles(snapshotLayout);
        }
    }

    private ensureInitialized(gitDirectory: string): Promise<void> {
        if (!this.initialization) {
            this.initialization = initializeGitStore(gitDirectory).catch((error) => {
                this.initialization = null;
                throw error;
            });
        }
        return this.initialization;
    }

    private gitEnvironment(layout: CheckpointStoreLayout, projectPath: string): NodeJS.ProcessEnv {
        const environment: NodeJS.ProcessEnv = {
            ...process.env,
            GIT_DIR: layout.gitDirectory,
            GIT_WORK_TREE: projectPath,
            GIT_INDEX_FILE: layout.indexFile,
            GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
            GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_AUTHOR_NAME: 'Saycode Checkpoint',
            GIT_AUTHOR_EMAIL: 'checkpoint@saycode.local',
            GIT_COMMITTER_NAME: 'Saycode Checkpoint',
            GIT_COMMITTER_EMAIL: 'checkpoint@saycode.local',
        };
        delete environment.GIT_NAMESPACE;
        delete environment.GIT_ALTERNATE_OBJECT_DIRECTORIES;
        return environment;
    }
}

type StagedSnapshot = { excludedPaths: string[] };

async function bindSnapshotFiles(
    request: CheckpointSnapshotRequest,
    layout: CheckpointStoreLayout,
    projectPath: string,
): Promise<void> {
    await mkdir(dirname(layout.indexFile), { recursive: true });
    await mkdir(dirname(layout.metadataFile), { recursive: true });
    await bindProjectPath(layout.metadataFile, request, projectPath);
}

async function completedSnapshot(
    request: CheckpointSnapshotRequest,
    snapshotLayout: CheckpointStoreLayout,
    projectPath: string,
    environment: NodeJS.ProcessEnv,
): Promise<CheckpointSnapshotResult | null> {
    const completedOperation = await runGit(
        ['rev-parse', '--verify', `${checkpointOperationRef(snapshotLayout, request.operationId)}^{commit}`],
        projectPath,
        environment,
        new Set([0, 128]),
    );
    if (completedOperation.exitCode !== 0) return null;
    await validateCapturedTree(completedOperation.stdout.trim(), request, projectPath, environment);
    return { checkpointId: completedOperation.stdout.trim(), created: false };
}

async function latestCheckpointId(
    layout: CheckpointStoreLayout,
    projectPath: string,
    environment: NodeJS.ProcessEnv,
): Promise<string | null> {
    const parent = await runGit(
        ['rev-parse', '--verify', `${layout.refName}^{commit}`],
        projectPath,
        environment,
        new Set([0, 128]),
    );
    return parent.exitCode === 0 ? parent.stdout.trim() : null;
}

/** Fills the snapshot's private index; writes objects but no tree, commit or ref. */
async function stageSnapshotIndex(
    request: CheckpointSnapshotRequest,
    layout: CheckpointStoreLayout,
    snapshotLayout: CheckpointStoreLayout,
    projectPath: string,
    environment: NodeJS.ProcessEnv,
    parentId: string | null,
): Promise<StagedSnapshot> {
    const workTreeIndex = request.workTree
        ? await copyIndexKeepingTimes(layout.indexFile, snapshotLayout.indexFile)
        : false;
    if (request.capturedFiles || (request.workTree && !workTreeIndex)) {
        await runGit(['read-tree', '--empty'], projectPath, environment);
    } else if (parentId && !request.workTree) {
        await runGit(['read-tree', parentId], projectPath, environment);
    }

    const excludedPatterns = normalizeExcludedPatterns(request.excludedPatterns ?? []);
    // A work tree takes its patterns as an ignore file: a glob exclude pathspec under an
    // ignored directory (`.aplus/worktrees/**`) makes `git add` fail on the ignored parent.
    const excludesFile = `${snapshotLayout.indexFile}.exclude`;
    const workTreeConfig = request.workTree ? ['-c', `core.excludesFile=${excludesFile}`] : [];
    if (request.workTree) await writeFile(excludesFile, excludedPatterns.map((pattern) => `${pattern}\n`).join(''), { mode: 0o600 });
    const excludedPaths = normalizeExcludedPaths([
        ...(request.excludedPaths ?? []),
        ...(request.workTree
            ? await unrecordedWorkTreePaths(request.workTree.maxFileBytes, workTreeConfig, projectPath, environment)
            : []),
    ]);
    const capturePathspec = `${snapshotLayout.indexFile}.paths`;
    if (request.capturedFiles) {
        const paths = normalizeExcludedPaths(request.capturedFiles.map((file) => file.path));
        if (paths.length > 0) {
            await writeFile(capturePathspec, paths.map((path) => `:(top,literal)${path}\0`).join(''), { mode: 0o600 });
            await runGit(['add', '-A', `--pathspec-from-file=${capturePathspec}`, '--pathspec-file-nul'], projectPath, environment);
        }
    } else await runGit([
        ...workTreeConfig,
        'add',
        '-A',
        '--',
        '.',
        ...excludedPaths.map((path) => `:(exclude,top,literal)${path}`),
        ...(request.workTree ? [] : excludedPatterns.map((pattern) => `:(exclude,top,glob)${pattern}`)),
    ], projectPath, environment, new Set([0]), request.workTree ? WORK_TREE_ADD_TIMEOUT_MS : undefined);
    if (excludedPaths.length > 0 || excludedPatterns.length > 0) {
        await runGit([
            'rm',
            '-r',
            '-f',
            '--cached',
            '--ignore-unmatch',
            '--',
            ...excludedPaths.map((path) => `:(top,literal)${path}`),
            ...excludedPatterns.map((pattern) => `:(top,glob)${pattern}`),
        ], projectPath, environment);
    }
    return { excludedPaths };
}

/** Turns a staged index into the checkpoint commit and its refs. Runs under the store lock. */
async function commitStagedSnapshot(
    request: CheckpointSnapshotRequest,
    layout: CheckpointStoreLayout,
    snapshotLayout: CheckpointStoreLayout,
    projectPath: string,
    environment: NodeJS.ProcessEnv,
    parentId: string | null,
    staged: StagedSnapshot,
): Promise<CheckpointSnapshotResult> {
    const operationRef = checkpointOperationRef(snapshotLayout, request.operationId);
    const tree = (await runGit(['write-tree'], projectPath, environment)).stdout.trim();
    await validateCapturedTree(tree, request, projectPath, environment);
    const body = checkpointBody({ ...request, excludedPaths: staged.excludedPaths });
    const keepIndex = async <T>(result: T): Promise<T> => {
        if (request.workTree) await rename(snapshotLayout.indexFile, layout.indexFile);
        return result;
    };
    if (parentId) {
        const parentTree = (await runGit(
            ['rev-parse', `${parentId}^{tree}`],
            projectPath,
            environment,
        )).stdout.trim();
        const parentBody = (await runGit(['show', '-s', '--format=%b', parentId], projectPath, environment)).stdout;
        if (tree === parentTree && parentBody.trim() === body) {
            return keepIndex(await completeCheckpointRefs({
                layout: snapshotLayout,
                operationRef,
                checkpointId: parentId,
                parentId,
                updateLatest: false,
                projectPath,
                environment,
            }));
        }
    }

    const createdAt = await nextCheckpointTimestamp(parentId, projectPath, environment);
    const messageFile = `${snapshotLayout.indexFile}.message`;
    await writeFile(messageFile, `saycode-checkpoint-v1 ${createdAt}\n\n${body}`, { mode: 0o600 });
    const commitArgs = ['commit-tree', tree, '-F', messageFile, '--no-gpg-sign'];
    const checkpointId = (await runGit(commitArgs, projectPath, environment)).stdout.trim();
    return keepIndex(await completeCheckpointRefs({
        layout: snapshotLayout,
        operationRef,
        checkpointId,
        parentId,
        updateLatest: true,
        projectPath,
        environment,
    }));
}

async function removeSnapshotFiles(snapshotLayout: CheckpointStoreLayout): Promise<void> {
    await rm(snapshotLayout.indexFile, { force: true });
    await rm(`${snapshotLayout.indexFile}.paths`, { force: true });
    await rm(`${snapshotLayout.indexFile}.message`, { force: true });
    await rm(`${snapshotLayout.indexFile}.exclude`, { force: true });
}

async function validateCapturedTree(
    tree: string,
    request: CheckpointSnapshotRequest,
    projectPath: string,
    environment: NodeJS.ProcessEnv,
): Promise<void> {
    if (!request.capturedFiles) return;
    const listing = await runGit(['ls-tree', '-rlz', tree], projectPath, environment);
    const expected = new Map(request.capturedFiles.map((file) => [file.path, file]));
    const entries = listing.stdout.split('\0').filter(Boolean);
    if (entries.length !== expected.size) throw new CheckpointPolicyDriftError();
    for (const entry of entries) {
        const match = entry.match(/^\d{6} blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/);
        const file = match ? expected.get(match[3]!) : undefined;
        if (!file || match![1] !== (match![1]!.length === 64 ? file.objectIdSha256 : file.objectId) || Number(match![2]) !== file.size) {
            throw new CheckpointPolicyDriftError();
        }
    }
    await request.validateCapture?.();
}

async function nextCheckpointTimestamp(
    parentId: string | null,
    projectPath: string,
    environment: NodeJS.ProcessEnv,
): Promise<number> {
    const currentTime = Date.now();
    if (!parentId) return currentTime;
    const parentSubject = (await runGit(
        ['show', '-s', '--format=%s', parentId],
        projectPath,
        environment,
    )).stdout.trim();
    const previousTimestamp = parentSubject.match(/^saycode-checkpoint-v1 (\d+)$/)?.[1];
    if (!previousTimestamp) return currentTime;
    const nextTimestamp = Number(previousTimestamp) + 1;
    return Number.isSafeInteger(nextTimestamp)
        ? Math.max(currentTime, nextTimestamp)
        : currentTime;
}

/**
 * Git decides whether an entry written in the same second as its index needs a content re-check
 * from the index file's mtime, so a copy keeps the original times.
 */
async function copyIndexKeepingTimes(source: string, target: string): Promise<boolean> {
    try {
        await copyFile(source, target);
        const times = await stat(source);
        await utimes(target, times.atime, times.mtime);
        return true;
    } catch {
        return false;
    }
}

function checkpointBody(request: CheckpointSnapshotRequest): string {
    const trailer = checkpointCoverageTrailer(request);
    if (!request.workTree) return trailer;
    const record = request.workTree.record ? `saycode-record ${request.workTree.record}\n` : '';
    return `${LOCAL_HISTORY_MARKER}\n${record}${trailer}`;
}

/**
 * Paths a local-history record leaves out, found through the index's stat cache: nested
 * repositories (git lists them as `dir/`, and one without a commit fails `git add`) and changed or
 * new regular files over the cap.
 */
async function unrecordedWorkTreePaths(
    maxFileBytes: number,
    workTreeConfig: string[],
    projectPath: string,
    environment: NodeJS.ProcessEnv,
): Promise<string[]> {
    const listing = await runGit([
        ...workTreeConfig,
        'ls-files', '-z', '--modified', '--others', '--exclude-standard',
    ], projectPath, environment, new Set([0]), WORK_TREE_ADD_TIMEOUT_MS);
    const oversized: string[] = [];
    for (const path of new Set(listing.stdout.split('\0').filter(Boolean))) {
        if (path.endsWith('/')) {
            oversized.push(path.slice(0, -1));
            continue;
        }
        const entry = await lstat(join(projectPath, path)).catch(() => null);
        if (entry?.isFile() && entry.size > maxFileBytes) oversized.push(path);
    }
    return oversized;
}

function checkpointOperationRef(layout: CheckpointStoreLayout, operationId: string): string {
    const operationKey = createHash('sha256').update(operationId).digest('hex');
    return `${checkpointOperationRefPrefix(layout)}/${operationKey}`;
}

async function completeCheckpointRefs(input: {
    layout: CheckpointStoreLayout;
    operationRef: string;
    checkpointId: string;
    parentId: string | null;
    updateLatest: boolean;
    projectPath: string;
    environment: NodeJS.ProcessEnv;
}): Promise<CheckpointSnapshotResult> {
    const commands = ['start'];
    if (input.updateLatest) {
        commands.push(input.parentId
            ? `update ${input.layout.refName} ${input.checkpointId} ${input.parentId}`
            : `create ${input.layout.refName} ${input.checkpointId}`);
    }
    commands.push(
        `create ${input.operationRef} ${input.checkpointId}`,
        'prepare',
        'commit',
        '',
    );
    try {
        await runGitRefTransaction(commands.join('\n'), input.projectPath, input.environment);
        return { checkpointId: input.checkpointId, created: input.updateLatest };
    } catch (error) {
        const completed = await runGit(
            ['rev-parse', '--verify', `${input.operationRef}^{commit}`],
            input.projectPath,
            input.environment,
            new Set([0, 128]),
        );
        if (completed.exitCode === 0) {
            return { checkpointId: completed.stdout.trim(), created: false };
        }
        throw error;
    }
}

function runGitRefTransaction(
    commands: string,
    cwd: string,
    environment: NodeJS.ProcessEnv,
): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn('git', ['update-ref', '--stdin'], {
            cwd,
            env: environment,
            stdio: ['pipe', 'ignore', 'pipe'],
        });
        let stderr = '';
        let settled = false;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (error) rejectPromise(error);
            else resolvePromise();
        };
        const timeout = setTimeout(() => {
            child.kill();
            finish(new Error('git update-ref transaction timed out'));
        }, 60_000);
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });
        child.once('error', (error) => finish(error));
        child.once('close', (code) => {
            if (code === 0) finish();
            else finish(new Error(`git update-ref transaction failed: ${stderr.trim()}`));
        });
        child.stdin.once('error', (error) => finish(error));
        child.stdin.end(commands);
    });
}

function normalizeExcludedPatterns(patterns: string[]): string[] {
    return [...new Set(patterns.map((pattern) => {
        if (
            pattern.length === 0
            || pattern.includes('\0')
            || pattern.startsWith('/')
            || pattern.startsWith('!')
            || pattern.split('/').includes('..')
        ) {
            throw new Error('checkpoint excluded pattern must be a project-relative glob');
        }
        return pattern;
    }))].sort();
}

function normalizeExcludedPaths(paths: string[]): string[] {
    return [...new Set(paths.map((path) => {
        if (
            path.length === 0
            || path.includes('\0')
            || /^(?:[A-Za-z]:|[\\/])/.test(path)
            || path.split(/[\\/]+/).includes('..')
        ) {
            throw new Error('checkpoint excluded path must be project-relative');
        }
        return path.split(sep).join('/');
    }))].sort();
}

async function bindProjectPath(
    metadataFile: string,
    request: CheckpointSnapshotRequest,
    projectPath: string,
): Promise<void> {
    try {
        const current = JSON.parse(await readFile(metadataFile, 'utf8')) as Record<string, unknown>;
        assertBindingMetadata(current, request, projectPath);
        return;
    } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
            throw error;
        }
    }

    try {
        await writeFile(metadataFile, JSON.stringify({
            sessionId: request.sessionId,
            projectId: request.projectId,
            worktreeId: request.worktreeId,
            projectPath,
        }), { flag: 'wx', mode: 0o600 });
    } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        const current = JSON.parse(await readFile(metadataFile, 'utf8')) as Record<string, unknown>;
        assertBindingMetadata(current, request, projectPath);
    }
}

function assertBindingMetadata(
    current: Record<string, unknown>,
    request: CheckpointSnapshotRequest,
    projectPath: string,
): void {
    if (current.projectPath !== projectPath) {
        throw new Error('checkpoint binding path mismatch');
    }
    if (
        current.sessionId !== request.sessionId
        || current.projectId !== request.projectId
        || current.worktreeId !== request.worktreeId
    ) {
        throw new Error('checkpoint binding identity mismatch');
    }
}

async function initializeGitStore(gitDirectory: string): Promise<void> {
    try {
        await readFile(join(gitDirectory, 'HEAD'));
        return;
    } catch {
        await mkdir(dirname(gitDirectory), { recursive: true });
    }

    const environment = { ...process.env };
    delete environment.GIT_DIR;
    delete environment.GIT_WORK_TREE;
    delete environment.GIT_INDEX_FILE;
    delete environment.GIT_NAMESPACE;
    delete environment.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    environment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
    environment.GIT_CONFIG_SYSTEM = process.platform === 'win32' ? 'NUL' : '/dev/null';
    environment.GIT_CONFIG_NOSYSTEM = '1';

    // Sessions that record for the first time at once race on one shared store; git init copies
    // its templates non-atomically. Build the store aside and install it with one rename, so a loser
    // finds a complete store instead of a half-written one.
    const staging = await mkdtemp(join(dirname(gitDirectory), '.store-init-'));
    try {
        await runGit(['init', '--bare', staging], dirname(gitDirectory), environment);
        await mkdir(join(staging, 'indexes'), { recursive: true });
        await mkdir(join(staging, 'bindings'), { recursive: true });
        await writeFile(join(staging, 'info', 'exclude'), '.git/\n');
        await rename(staging, gitDirectory).catch(async (error) => {
            if (!(error instanceof Error && 'code' in error && (error.code === 'ENOTEMPTY' || error.code === 'EEXIST'))) throw error;
            await readFile(join(gitDirectory, 'HEAD'));
        });
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}

function runGit(
    args: string[],
    cwd: string,
    environment: NodeJS.ProcessEnv,
    allowedExitCodes = new Set([0]),
    timeout = 60_000,
): Promise<GitResult> {
    return new Promise((resolvePromise, rejectPromise) => {
        execFile('git', args, {
            cwd,
            env: environment,
            encoding: 'utf8',
            maxBuffer: 256 * 1024 * 1024,
            timeout,
        }, (error, stdout, stderr) => {
            const exitCode = typeof error?.code === 'number' ? error.code : error ? -1 : 0;
            if (error && !allowedExitCodes.has(exitCode)) {
                rejectPromise(new Error(`git ${args[0]} failed: ${stderr || error.message}`));
                return;
            }
            resolvePromise({ stdout, stderr, exitCode });
        });
    });
}
