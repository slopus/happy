import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { z } from 'zod';
import type { CheckpointProtectionState } from './checkpointContract';
import type { CheckpointEventPublisher } from './checkpointEventPublisher';
import {
    CheckpointProtectionStateStore,
    type CheckpointPendingDecision,
} from './checkpointProtectionState';
import { CheckpointRestoreExecutor } from './checkpointRestore';
import { LOCAL_HISTORY_MAX_FILE_BYTES } from './checkpointLocalHistory';
import { CheckpointRestorePlanner } from './checkpointRestorePlan';
import { checkpointOperationRefPrefix, resolveCheckpointStoreLayout } from './checkpointStore';
import { checkpointRecoveryStatus } from './checkpointRecovery';

const identifierSchema = z.string().min(1).max(128).refine(
    (value) => value.trim() === value && !/[\u0000-\u001F\u007F]/.test(value),
    'identifier must not contain surrounding whitespace or control characters',
);
const operationIdSchema = z.string().regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);

const bindingRequestSchema = z.object({
    schemaVersion: z.literal(1),
    sessionId: identifierSchema,
    projectId: identifierSchema,
    worktreeId: identifierSchema.nullable(),
}).strict();

const projectRelativePathsSchema = z.array(z.string().min(1).refine((value) => (
    !value.includes('\0')
    && !/^(?:[A-Za-z]:|[\\/])/.test(value)
    && !value.split(/[\\/]+/).includes('..')
), 'path must be project-relative')).max(10_000);

const previewRequestSchema = bindingRequestSchema.extend({
    checkpointId: z.string().regex(/^[a-f0-9]{40,64}$/),
    includePaths: projectRelativePathsSchema.optional(),
}).strict();

const cancelRequestSchema = bindingRequestSchema.extend({
    operationId: operationIdSchema,
}).strict();

const decisionRequestSchema = cancelRequestSchema.extend({
    decision: z.enum(['cancel', 'disable-protection']),
}).strict();

const restartRequestSchema = bindingRequestSchema.extend({
    timeout: z.literal(70_000),
}).strict();
const refreshRequestSchema = restartRequestSchema.extend({
    operationId: operationIdSchema,
    requestId: operationIdSchema,
    revision: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const projectRelativePathSchema = z.string().min(1).refine((value) => (
    !value.includes('\0')
    && !/^(?:[A-Za-z]:|[\\/])/.test(value)
    && !value.split(/[\\/]+/).includes('..')
), 'path must be project-relative');

const restorePlanEntrySchema = z.discriminatedUnion('action', [
    z.object({
        path: projectRelativePathSchema,
        action: z.literal('restore'),
        reason: z.enum(['agent-modified', 'agent-deleted']),
    }).strict(),
    z.object({
        path: projectRelativePathSchema,
        action: z.literal('delete'),
        reason: z.literal('agent-created'),
    }).strict(),
    z.object({
        path: projectRelativePathSchema,
        action: z.literal('skip'),
        reason: z.enum(['user-modified', 'provenance-unknown']),
    }).strict(),
    z.object({
        path: projectRelativePathSchema,
        action: z.literal('conflict'),
        reason: z.enum(['unsupported-file-type', 'unsafe-path']),
    }).strict(),
]);

const restorePlanSchema = z.object({
    schemaVersion: z.literal(1),
    checkpointId: z.string().regex(/^[a-f0-9]{40,64}$/),
    entries: z.array(restorePlanEntrySchema),
    // A preview echoed back whole carries its details; they never change what runs.
    skipDetails: z.array(z.unknown()).optional(),
}).strict();

const executeRequestSchema = bindingRequestSchema.extend({
    operationId: operationIdSchema,
    confirmed: z.literal(true),
    plan: restorePlanSchema,
    includePaths: projectRelativePathsSchema.optional(),
}).strict();

export type CheckpointRpcSessionAuthority = {
    sessionId: string;
    projectId: string;
    worktreeId: string | null;
    projectPath: string;
    protection: CheckpointProtectionState;
    pendingDecision: CheckpointPendingDecision | null;
    excludedPaths: string[];
    excludedPatterns: string[];
    canRestoreHistory?: boolean;
    limits?: { maxFileBytes: number; maxFiles: number; maxTotalBytes: number };
    /** specs/checkpoint-local-history R5 — additive: a Desktop that knows it drops the old decision UI. */
    mode?: 'local-history';
};

export type CheckpointRpcHandlers = {
    status(params: unknown): Promise<unknown>;
    list(params: unknown): Promise<unknown>;
    preview(params: unknown): Promise<unknown>;
    execute(params: unknown): Promise<unknown>;
    retry(params: unknown): Promise<unknown>;
    cancel(params: unknown): Promise<unknown>;
    decision(params: unknown): Promise<unknown>;
    restart(params: unknown): Promise<unknown>;
    refresh?(params: unknown): Promise<unknown>;
};

export function createCheckpointRpcHandlers(input: {
    checkpointRoot: string;
    resolveAuthority(sessionId: string): Promise<CheckpointRpcSessionAuthority | null>;
    resolveEventPublisher(sessionId: string): Promise<Pick<CheckpointEventPublisher, 'rewind'> | null>;
    restartSession(authority: CheckpointRpcSessionAuthority): Promise<void>;
    refreshSession?(authority: CheckpointRpcSessionAuthority): Promise<void>;
    restoreExecutor?: CheckpointRestoreExecutor;
}): CheckpointRpcHandlers {
    const restoreExecutor = input.restoreExecutor ?? new CheckpointRestoreExecutor(input.checkpointRoot);
    const protectionState = new CheckpointProtectionStateStore(input.checkpointRoot);
    const resolveRequestAuthority = async (request: z.infer<typeof bindingRequestSchema>) => {
        const authority = await input.resolveAuthority(request.sessionId);
        if (!authority) throw new Error('checkpoint RPC session authority is unavailable');
        if (
            authority.sessionId !== request.sessionId
            || authority.projectId !== request.projectId
            || authority.worktreeId !== request.worktreeId
        ) {
            throw new Error('checkpoint RPC binding mismatch');
        }
        return authority;
    };

    return {
        status: async (params) => {
            const request = bindingRequestSchema.parse(params);
            const authority = await resolveRequestAuthority(request);
            return {
                schemaVersion: 1 as const,
                sessionId: authority.sessionId,
                projectId: authority.projectId,
                worktreeId: authority.worktreeId,
                protection: authority.protection,
                ...(authority.mode ? { mode: authority.mode } : {}),
                pendingDecision: authority.pendingDecision,
                ...(input.refreshSession ? { recovery: checkpointRecoveryStatus({
                    pendingDecision: authority.pendingDecision,
                    canRestoreHistory: authority.protection.status === 'protected' || authority.canRestoreHistory === true,
                    limits: authority.limits,
                }) } : {}),
            };
        },
        list: async (params) => {
            const request = bindingRequestSchema.parse(params);
            const authority = await resolveRequestAuthority(request);
            return {
                schemaVersion: 1 as const,
                checkpoints: await listOwnedCheckpoints(input.checkpointRoot, authority),
            };
        },
        preview: async (params) => {
            const request = previewRequestSchema.parse(params);
            const authority = await resolveRequestAuthority(request);
            const { plan, details } = await new CheckpointRestorePlanner(input.checkpointRoot).planWithDetails({
                sessionId: authority.sessionId,
                projectId: authority.projectId,
                worktreeId: authority.worktreeId,
                projectPath: authority.projectPath,
                checkpointId: request.checkpointId,
                excludedPaths: authority.excludedPaths,
                excludedPatterns: authority.excludedPatterns,
                includePaths: request.includePaths,
            });
            return { schemaVersion: 1 as const, ...plan, ...(details.length > 0 ? { skipDetails: details } : {}) };
        },
        execute: async (params) => {
            const request = executeRequestSchema.parse(params);
            const authority = await resolveRequestAuthority(request);
            if (authority.pendingDecision || (authority.protection.status !== 'protected'
                && !(authority.protection.status === 'legacy' && authority.canRestoreHistory))) {
                throw new Error('checkpoint RPC mutation requires protected status');
            }
            const eventPublisher = await input.resolveEventPublisher(request.sessionId);
            if (!eventPublisher) throw new Error('checkpoint event publisher is unavailable');
            const result = await restoreExecutor.execute({
                sessionId: authority.sessionId,
                projectId: authority.projectId,
                worktreeId: authority.worktreeId,
                projectPath: authority.projectPath,
                operationId: request.operationId,
                confirmed: true,
                plan: {
                    checkpointId: request.plan.checkpointId,
                    entries: request.plan.entries,
                },
                excludedPaths: authority.excludedPaths,
                excludedPatterns: authority.excludedPatterns,
                includePaths: request.includePaths,
                ...(authority.mode === 'local-history' ? { localHistory: { maxFileBytes: LOCAL_HISTORY_MAX_FILE_BYTES } } : {}),
            });
            await publishRewindResult(eventPublisher, request, result);
            return {
                schemaVersion: 1 as const,
                operationId: request.operationId,
                ...result,
            };
        },
        retry: async (params) => {
            const request = executeRequestSchema.parse(params);
            const authority = await resolveRequestAuthority(request);
            if (authority.pendingDecision || (authority.protection.status !== 'protected'
                && !(authority.protection.status === 'legacy' && authority.canRestoreHistory))) {
                throw new Error('checkpoint RPC mutation requires protected status');
            }
            const eventPublisher = await input.resolveEventPublisher(request.sessionId);
            if (!eventPublisher) throw new Error('checkpoint event publisher is unavailable');
            const result = await restoreExecutor.execute({
                sessionId: authority.sessionId,
                projectId: authority.projectId,
                worktreeId: authority.worktreeId,
                projectPath: authority.projectPath,
                operationId: request.operationId,
                confirmed: true,
                plan: {
                    checkpointId: request.plan.checkpointId,
                    entries: request.plan.entries,
                },
                excludedPaths: authority.excludedPaths,
                excludedPatterns: authority.excludedPatterns,
                includePaths: request.includePaths,
                ...(authority.mode === 'local-history' ? { localHistory: { maxFileBytes: LOCAL_HISTORY_MAX_FILE_BYTES } } : {}),
            });
            await publishRewindResult(eventPublisher, request, result);
            return {
                schemaVersion: 1 as const,
                operationId: request.operationId,
                ...result,
            };
        },
        cancel: async (params) => {
            const request = cancelRequestSchema.parse(params);
            await resolveRequestAuthority(request);
            return {
                schemaVersion: 1 as const,
                operationId: request.operationId,
                status: 'cancelled' as const,
            };
        },
        decision: async (params) => {
            const request = decisionRequestSchema.parse(params);
            const authority = await resolveRequestAuthority(request);
            const status = await protectionState.resolveDecision({
                sessionId: authority.sessionId,
                projectId: authority.projectId,
                worktreeId: authority.worktreeId,
                projectPath: authority.projectPath,
                operationId: request.operationId,
                decision: request.decision,
            });
            return {
                schemaVersion: 1 as const,
                sessionId: authority.sessionId,
                projectId: authority.projectId,
                worktreeId: authority.worktreeId,
                ...status,
            };
        },
        restart: async (params) => {
            const request = restartRequestSchema.parse(params);
            const authority = await resolveRequestAuthority(request);
            if (
                authority.protection.status !== 'unavailable'
                || authority.protection.reason !== 'excluded-path'
            ) {
                throw new Error('checkpoint restart requires disabled checkpoint protection');
            }
            await input.restartSession(authority);
            return {
                schemaVersion: 1 as const,
                sessionId: authority.sessionId,
                projectId: authority.projectId,
                worktreeId: authority.worktreeId,
                status: 'restarted' as const,
            };
        },
        ...(input.refreshSession ? { refresh: async (params: unknown) => {
            const request = refreshRequestSchema.parse(params);
            const authority = await resolveRequestAuthority(request);
            const status = await protectionState.refreshPending({
                ...authority, operationId: request.operationId, requestId: request.requestId, revision: request.revision,
            }, () => input.refreshSession!(authority));
            return { schemaVersion: 1, sessionId: authority.sessionId, projectId: authority.projectId,
                worktreeId: authority.worktreeId, requestId: request.requestId, status };
        } } : {}),
    };
}

async function publishRewindResult(
    publisher: Pick<CheckpointEventPublisher, 'rewind'>,
    request: z.infer<typeof executeRequestSchema>,
    result: Awaited<ReturnType<CheckpointRestoreExecutor['execute']>>,
): Promise<void> {
    if (result.status !== 'completed' && result.status !== 'partial') return;
    const files = result.entries.map((entry, index) => {
        const planEntry = request.plan.entries[index];
        if (!planEntry || planEntry.path !== entry.path || planEntry.action !== entry.action) {
            throw new Error('checkpoint restore result does not match its confirmed plan');
        }
        if (planEntry.action === 'restore') {
            return {
                path: planEntry.path,
                action: planEntry.reason === 'agent-deleted' ? 'created' as const : 'modified' as const,
            };
        }
        if (planEntry.action === 'delete') return { path: planEntry.path, action: 'deleted' as const };
        if (planEntry.action === 'skip') return { path: planEntry.path, action: 'skipped' as const };
        return { path: planEntry.path, action: 'conflict' as const };
    });
    await publisher.rewind({
        operationId: request.operationId,
        checkpointId: request.plan.checkpointId,
        state: result.status,
        files,
    });
}

async function listOwnedCheckpoints(
    checkpointRoot: string,
    authority: CheckpointRpcSessionAuthority,
): Promise<Array<{ checkpointId: string; createdAt: number }>> {
    const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...authority });
    try {
        await access(layout.gitDirectory);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
        throw error;
    }
    const environment = checkpointGitEnvironment(layout.gitDirectory);
    const operationRefs = await runGit(
        [
            'for-each-ref',
            '--format=%(objectname)%09%(contents:subject)%09%(creatordate:unix)',
            checkpointOperationRefPrefix(layout),
        ],
        authority.projectPath,
        environment,
    );
    if (operationRefs.exitCode !== 0) throw new Error(`checkpoint list failed: ${operationRefs.stderr}`);
    let history = operationRefs.stdout.trim().split('\n').filter(Boolean).map((line) => {
        const [checkpointId, subject, fallbackTimestamp, ...remainder] = line.split('\t');
        const messageTimestamp = subject?.match(/^saycode-checkpoint-v1 (\d+)$/)?.[1];
        const timestamp = messageTimestamp ?? (fallbackTimestamp && `${Number(fallbackTimestamp) * 1000}`);
        if (
            remainder.length > 0
            || !/^\d+$/.test(timestamp ?? '')
            || !/^[a-f0-9]{40,64}$/.test(checkpointId ?? '')
        ) {
            throw new Error('checkpoint list contains invalid history');
        }
        return { checkpointId: checkpointId!, createdAt: Number(timestamp) };
    });
    if (history.length === 0) {
        const ref = await runGit(['show-ref', '--verify', '--quiet', layout.refName], authority.projectPath, environment);
        if (ref.exitCode === 1) return [];
        if (ref.exitCode !== 0) throw new Error(`checkpoint list failed: ${ref.stderr}`);
        const legacy = await runGit(['rev-list', '--timestamp', layout.refName], authority.projectPath, environment);
        if (legacy.exitCode !== 0) throw new Error(`checkpoint list failed: ${legacy.stderr}`);
        history = legacy.stdout.trim().split('\n').filter(Boolean).map((line) => {
            const [timestamp, checkpointId, ...remainder] = line.split(' ');
            if (remainder.length > 0 || !/^\d+$/.test(timestamp ?? '') || !/^[a-f0-9]{40,64}$/.test(checkpointId ?? '')) {
                throw new Error('checkpoint list contains invalid history');
            }
            return { checkpointId: checkpointId!, createdAt: Number(timestamp) * 1000 };
        });
    }
    return [...new Map(history.map((checkpoint) => [checkpoint.checkpointId, checkpoint])).values()]
        .sort((left, right) => right.createdAt - left.createdAt || right.checkpointId.localeCompare(left.checkpointId));
}

function checkpointGitEnvironment(gitDirectory: string): NodeJS.ProcessEnv {
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
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolvePromise, rejectPromise) => {
        execFile('git', args, {
            cwd,
            env: environment,
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024,
            timeout: 60_000,
        }, (error, stdout, stderr) => {
            if (error && typeof error.code !== 'number') {
                rejectPromise(error);
                return;
            }
            resolvePromise({
                exitCode: error && typeof error.code === 'number' ? error.code : 0,
                stdout,
                stderr,
            });
        });
    });
}
