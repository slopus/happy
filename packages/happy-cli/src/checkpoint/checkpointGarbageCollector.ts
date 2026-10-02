import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { observeCheckpointOperation, type CheckpointOperationObserver } from './checkpointObservability';
import {
    checkpointOperationRefPrefix,
    checkpointPinRefPrefix,
    resolveCheckpointStoreLayout,
    type CheckpointStoreBinding,
} from './checkpointStore';
import { oldestCheckpointStagingStart, withCheckpointStoreLock } from './checkpointStoreLock';

type RetentionPolicy = {
    maxCheckpointsPerBinding?: number;
    maxAgeMs?: number;
    maxStoreBytes?: number;
    now?: number;
};

type CheckpointRef = {
    refName: string;
    checkpointId: string;
    bindingKey: string;
    createdAt: number;
};

type CheckpointPins = {
    bindingKeys: Set<string>;
    checkpointKeys: Set<string>;
};

export class CheckpointGarbageCollector {
    private readonly checkpointRoot: string;
    private readonly observer: CheckpointOperationObserver | undefined;

    constructor(checkpointRoot: string, options: { observer?: CheckpointOperationObserver } = {}) {
        this.checkpointRoot = resolve(checkpointRoot);
        this.observer = options.observer;
    }

    collect(policy: RetentionPolicy): Promise<{
        prunedCheckpoints: number;
        retainedActive: number;
        storeBytes: number;
    }> {
        return observeCheckpointOperation(
            'gc',
            () => this.collectPolicy(policy),
            (result) => result,
            { observer: this.observer },
        );
    }

    private async collectPolicy(policy: RetentionPolicy): Promise<{
        prunedCheckpoints: number;
        retainedActive: number;
        storeBytes: number;
    }> {
        validatePolicy(policy);
        const gitDirectory = join(this.checkpointRoot, 'store');
        try {
            await access(gitDirectory);
        } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                return { prunedCheckpoints: 0, retainedActive: 0, storeBytes: 0 };
            }
            throw error;
        }
        return withCheckpointStoreLock(this.checkpointRoot, () => this.collectLocked(policy));
    }

    private async collectLocked(policy: RetentionPolicy): Promise<{
        prunedCheckpoints: number;
        retainedActive: number;
        storeBytes: number;
    }> {
        const gitDirectory = join(this.checkpointRoot, 'store');
        const [refs, pins] = await Promise.all([
            listCheckpointRefs(gitDirectory),
            listCheckpointPins(gitDirectory),
        ]);
        const managedBindings = new Set(refs.map(({ bindingKey }) => bindingKey));
        const expired = selectExpired(refs, pins.bindingKeys, policy);
        const pruned = new Set<string>();
        if (expired.size > 0) {
            await deleteCheckpointRefs(gitDirectory, refs, expired);
            for (const key of expired) pruned.add(key);
            await updateLatestRefs(
                gitDirectory,
                refs.filter((ref) => !expired.has(checkpointKey(ref))),
                managedBindings,
            );
            await reclaimObjects(gitDirectory);
        }

        if (policy.maxStoreBytes !== undefined) {
            let remaining = refs.filter((ref) => !pruned.has(checkpointKey(ref)));
            let storeBytes = await directorySize(gitDirectory);
            for (const checkpoint of oldestUnique(remaining)) {
                if (storeBytes <= policy.maxStoreBytes) break;
                if (pins.bindingKeys.has(checkpoint.bindingKey)) continue;
                const selected = new Set([checkpointKey(checkpoint)]);
                await deleteCheckpointRefs(gitDirectory, remaining, selected);
                pruned.add(checkpointKey(checkpoint));
                remaining = remaining.filter((ref) => checkpointKey(ref) !== checkpointKey(checkpoint));
                await updateLatestRefs(gitDirectory, remaining, managedBindings);
                await reclaimObjects(gitDirectory);
                storeBytes = await directorySize(gitDirectory);
            }
        }

        return {
            prunedCheckpoints: pruned.size,
            retainedActive: pins.checkpointKeys.size,
            storeBytes: await directorySize(gitDirectory),
        };
    }
}

export async function withCheckpointPin<T>(
    checkpointRoot: string,
    request: Omit<CheckpointStoreBinding, 'checkpointRoot'> & {
        checkpointId: string;
        operationId: string;
    },
    action: () => Promise<T>,
): Promise<T> {
    if (!/^[a-f0-9]{40,64}$/.test(request.checkpointId)) {
        throw new Error('checkpoint pin target is invalid');
    }
    const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...request });
    const pinKey = createHash('sha256')
        .update(`${request.operationId}\0${randomUUID()}`)
        .digest('hex');
    const pinRef = `${checkpointPinRefPrefix(layout)}/${pinKey}`;
    const environment = gitEnvironment(layout.gitDirectory);
    const owned = await runGit([
        'for-each-ref',
        '--format=%(refname)',
        `--points-at=${request.checkpointId}`,
        checkpointOperationRefPrefix(layout),
    ], layout.gitDirectory, environment);
    if (owned.stdout.trim().length === 0) {
        throw new Error('checkpoint pin target does not belong to binding');
    }
    await runGit(['update-ref', pinRef, request.checkpointId, ''], layout.gitDirectory, environment);
    try {
        return await action();
    } finally {
        await runGit(['update-ref', '-d', pinRef], layout.gitDirectory, environment);
    }
}

function validatePolicy(policy: RetentionPolicy): void {
    const limits = [policy.maxCheckpointsPerBinding, policy.maxAgeMs, policy.maxStoreBytes];
    if (limits.every((value) => value === undefined)) {
        throw new Error('checkpoint retention policy requires a limit');
    }
    if (limits.some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) {
        throw new Error('checkpoint retention limit is invalid');
    }
    if (policy.now !== undefined && (!Number.isSafeInteger(policy.now) || policy.now < 0)) {
        throw new Error('checkpoint retention time is invalid');
    }
}

async function listCheckpointRefs(gitDirectory: string): Promise<CheckpointRef[]> {
    const result = await runGit([
        'for-each-ref',
        '--format=%(refname)%09%(objectname)%09%(contents:subject)%09%(creatordate:unix)',
        'refs/saycode-checkpoint-operations',
    ], gitDirectory, gitEnvironment(gitDirectory));
    return result.stdout.trim().split('\n').filter(Boolean).map((line) => {
        const [refName, checkpointId, subject, fallbackTimestamp, ...extra] = line.split('\t');
        const match = refName?.match(/^refs\/saycode-checkpoint-operations\/([a-f0-9]{64})\/[a-f0-9]{64}$/);
        const messageTimestamp = subject?.match(/^saycode-checkpoint-v1 (\d+)$/)?.[1];
        const timestamp = messageTimestamp ?? (fallbackTimestamp && `${Number(fallbackTimestamp) * 1000}`);
        if (!match || extra.length > 0 || !/^[a-f0-9]{40,64}$/.test(checkpointId ?? '') || !/^\d+$/.test(timestamp ?? '')) {
            throw new Error('checkpoint retention ref is invalid');
        }
        return {
            refName: refName!,
            checkpointId: checkpointId!,
            bindingKey: match[1]!,
            createdAt: Number(timestamp),
        };
    });
}

async function listCheckpointPins(gitDirectory: string): Promise<CheckpointPins> {
    const result = await runGit([
        'for-each-ref',
        '--format=%(refname)%09%(objectname)',
        'refs/saycode-checkpoint-pins',
    ], gitDirectory, gitEnvironment(gitDirectory));
    const bindingKeys = new Set<string>();
    const checkpointKeys = new Set<string>();
    for (const line of result.stdout.trim().split('\n').filter(Boolean)) {
        const [refName, checkpointId, ...extra] = line.split('\t');
        const match = refName?.match(/^refs\/saycode-checkpoint-pins\/([a-f0-9]{64})\/[a-f0-9]{64}$/);
        if (!match || extra.length > 0 || !/^[a-f0-9]{40,64}$/.test(checkpointId ?? '')) {
            throw new Error('checkpoint retention pin is invalid');
        }
        bindingKeys.add(match[1]!);
        checkpointKeys.add(`${match[1]}:${checkpointId}`);
    }
    return { bindingKeys, checkpointKeys };
}

function selectExpired(
    refs: CheckpointRef[],
    pinnedBindings: Set<string>,
    policy: RetentionPolicy,
): Set<string> {
    const expired = new Set<string>();
    const now = policy.now ?? Date.now();
    const byBinding = groupByBinding(oldestUnique(refs));
    for (const [bindingKey, checkpoints] of byBinding) {
        if (pinnedBindings.has(bindingKey)) continue;
        const newest = [...checkpoints].sort(newestFirst);
        for (const [index, checkpoint] of newest.entries()) {
            const overCount = policy.maxCheckpointsPerBinding !== undefined
                && index >= policy.maxCheckpointsPerBinding;
            const overAge = policy.maxAgeMs !== undefined
                && checkpoint.createdAt < now - policy.maxAgeMs;
            if (overCount || overAge) {
                expired.add(checkpointKey(checkpoint));
            }
        }
    }
    return expired;
}

function oldestUnique(refs: CheckpointRef[]): CheckpointRef[] {
    const unique = new Map<string, CheckpointRef>();
    for (const ref of [...refs].sort(newestFirst)) {
        const key = checkpointKey(ref);
        if (!unique.has(key)) unique.set(key, ref);
    }
    return [...unique.values()].sort((left, right) => -newestFirst(left, right));
}

function newestFirst(left: CheckpointRef, right: CheckpointRef): number {
    return right.createdAt - left.createdAt || right.checkpointId.localeCompare(left.checkpointId);
}

async function deleteCheckpointRefs(
    gitDirectory: string,
    refs: CheckpointRef[],
    checkpointKeys: Set<string>,
): Promise<void> {
    for (const ref of refs) {
        if (checkpointKeys.has(checkpointKey(ref))) {
            await runGit(['update-ref', '-d', ref.refName], gitDirectory, gitEnvironment(gitDirectory));
        }
    }
}

async function updateLatestRefs(
    gitDirectory: string,
    refs: CheckpointRef[],
    managedBindings: Set<string>,
): Promise<void> {
    const byBinding = groupByBinding(oldestUnique(refs));
    for (const bindingKey of managedBindings) {
        const refName = `refs/saycode-checkpoints/${bindingKey}`;
        const latest = byBinding.get(bindingKey)?.sort(newestFirst)[0];
        await runGit(
            latest ? ['update-ref', refName, latest.checkpointId] : ['update-ref', '-d', refName],
            gitDirectory,
            gitEnvironment(gitDirectory),
        );
    }
}

function checkpointKey(ref: Pick<CheckpointRef, 'bindingKey' | 'checkpointId'>): string {
    return `${ref.bindingKey}:${ref.checkpointId}`;
}

function groupByBinding(refs: CheckpointRef[]): Map<string, CheckpointRef[]> {
    const groups = new Map<string, CheckpointRef[]>();
    for (const ref of refs) {
        const group = groups.get(ref.bindingKey) ?? [];
        group.push(ref);
        groups.set(ref.bindingKey, group);
    }
    return groups;
}

async function reclaimObjects(gitDirectory: string): Promise<void> {
    const environment = gitEnvironment(gitDirectory);
    await runGit(['reflog', 'expire', '--expire=now', '--all'], gitDirectory, environment);
    // A record staging outside the lock has written objects no ref reaches yet; keep anything
    // newer than its start (with a minute of slack for coarse file times).
    const stagingStart = await oldestCheckpointStagingStart(gitDirectory);
    const prune = stagingStart === null
        ? 'now'
        : `${Math.ceil(Math.max(0, Date.now() - stagingStart) / 1000) + 60}.seconds.ago`;
    await runGit(['gc', `--prune=${prune}`, '--quiet'], gitDirectory, environment);
}

async function directorySize(path: string): Promise<number> {
    const stats = await lstat(path);
    if (!stats.isDirectory()) return stats.size;
    let size = 0;
    for (const entry of await readdir(path)) size += await directorySize(join(path, entry));
    return size;
}

function gitEnvironment(gitDirectory: string): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_DIR: gitDirectory,
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
    };
    delete environment.GIT_WORK_TREE;
    delete environment.GIT_INDEX_FILE;
    delete environment.GIT_NAMESPACE;
    delete environment.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    return environment;
}

function runGit(
    args: string[],
    cwd: string,
    environment: NodeJS.ProcessEnv,
    allowedExitCodes = new Set([0]),
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolvePromise, rejectPromise) => {
        execFile('git', args, {
            cwd,
            env: environment,
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024,
            timeout: 180_000,
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
