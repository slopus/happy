import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { SandboxConfig } from '@/persistence';
import { buildSandboxRuntimeConfig } from '@/sandbox/config';
import type { SandboxPolicyMode } from '@/sandbox/sandboxPolicy';
import type { QueryOptions } from '@/claude/sdk';
import { createCheckpointRuntime } from './checkpointRuntime';
import { readCheckpointSpawnContext } from './checkpointSpawnContext';
import { checkpointAttachmentPassthroughCandidates } from './checkpointAttachmentPassthrough';
import {
    CheckpointPolicyDriftError,
    CheckpointExclusionGuard,
    resolveCheckpointProtectionCapability,
    type CheckpointProvider,
} from './checkpointExclusionPolicy';
import type { CheckpointEventPublisher } from './checkpointEventPublisher';
import { CheckpointProtectionStateStore } from './checkpointProtectionState';
import { checkpointExclusionChanges } from './checkpointRecovery';
import { CheckpointTurnWorkspace } from './checkpointTurnWorkspace';
import { CheckpointTurnApplier, type CheckpointTurnApplyResult } from './checkpointTurnApply';
import { CheckpointWriterProcessTree } from './checkpointWriterProcessTree';

export type CheckpointTurnPreparation = {
    operationId: string;
    checkpointId: string;
    providerPath: string;
    sandboxConfig?: SandboxConfig;
    claudeSandbox?: QueryOptions['sandbox'];
};

export type CheckpointSessionComposition = {
    sandboxConfig: SandboxConfig | undefined;
    providerPath?: string;
    beforeTurn?: () => Promise<CheckpointTurnPreparation>;
    completeTurn?: (quiesceWriters: () => Promise<void>) => Promise<CheckpointTurnApplyResult>;
    protectedBashCwd?: () => string | null;
    trackProtectedWriter?: (child: ChildProcess) => void;
    /** Removes a reserved-but-unused provider workspace; an active turn is left untouched. */
    dispose?: () => Promise<void>;
    /** Discards a turn that was opened but never dispatched, then rotates to a fresh workspace. */
    abortTurn?: () => Promise<void>;
    /** Marks the open turn as sent to the provider: its result is no longer discardable. */
    markTurnDispatched?: () => void;
    claudeSandbox?: QueryOptions['sandbox'];
};

export async function createCheckpointSessionComposition(input: {
    provider: CheckpointProvider;
    platform: NodeJS.Platform;
    projectPath: string;
    sessionId: string;
    sandboxConfig: SandboxConfig | undefined;
    env: Record<string, string | undefined>;
    checkpointEvents?: Pick<CheckpointEventPublisher, 'snapshot'>;
    /**
     * 생략하면 개인 머신(owner-choice). 이 값이 빠지면 checkpoint 세션의 runtime
     * 설정이 기본 owner-choice 로 만들어져 공유 머신 신뢰 floor 가 통째로 빠진다
     * — 런처가 checkpoint 설정을 그대로 쓰고 실제 실행도 턴 설정을 우선하므로,
     * 이 인자가 그 경로의 유일한 전달 지점이다.
     */
    sandboxPolicyMode?: SandboxPolicyMode;
}): Promise<CheckpointSessionComposition> {
    const policyMode: SandboxPolicyMode = input.sandboxPolicyMode ?? 'owner-choice';
    const inputSandboxConfig = input.sandboxConfig;
    const protection = inputSandboxConfig?.checkpointProtection;
    if (!protection) return { sandboxConfig: input.sandboxConfig };
    if (!inputSandboxConfig.enabled) {
        throw new Error('checkpoint protection requires an enabled sandbox');
    }
    const context = readCheckpointSpawnContext(input.env);
    if (!context) {
        throw new Error('checkpoint protection requires authoritative checkpoint spawn context');
    }
    await mkdir(context.checkpointRoot, { recursive: true, mode: 0o700 });
    const canonicalCheckpointRoot = await realpath(context.checkpointRoot);
    const canonicalProjectPath = await realpath(input.projectPath);
    const workspaceBinding = {
        sessionId: input.sessionId,
        projectId: context.projectId,
        worktreeId: context.worktreeId,
    };
    const protectionState = new CheckpointProtectionStateStore(canonicalCheckpointRoot);
    const persistedProtection = await protectionState.read({
        ...workspaceBinding,
        projectPath: canonicalProjectPath,
    });
    if (persistedProtection.protection.status === 'unavailable') {
        const { checkpointProtection: _checkpointProtection, ...unprotectedSandbox } = inputSandboxConfig;
        return { sandboxConfig: unprotectedSandbox };
    }
    const capability = resolveCheckpointProtectionCapability(input);
    if (!capability.supported) {
        throw new Error(`checkpoint protection unavailable: ${capability.reason}`);
    }
    const checkpointEvents = input.checkpointEvents;
    if (!checkpointEvents) {
        throw new Error('checkpoint protection requires a durable event publisher');
    }
    const buildRuntime = (passthroughPaths: string[] | undefined) => createCheckpointRuntime({
        provider: input.provider,
        platform: input.platform,
        projectPath: input.projectPath,
        checkpointRoot: canonicalCheckpointRoot,
        binding: {
            sessionId: input.sessionId,
            projectId: context.projectId,
            worktreeId: context.worktreeId,
        },
        protection: passthroughPaths
            ? { ...protection, readOnlyPassthroughPaths: passthroughPaths }
            : protection,
    });
    // Expose the chat-attachment upload directory to the turn workspace. A
    // passthrough is a convenience, never a gate: if no candidate can be
    // prepared or the manifest rejects them all, the session must still start
    // without one rather than fail closed on an attachment feature.
    const attachmentCandidates = await checkpointAttachmentPassthroughCandidates(
        canonicalProjectPath,
    );
    const runtime = await (async () => {
        for (const candidate of attachmentCandidates) {
            try {
                return await buildRuntime([
                    ...(protection.readOnlyPassthroughPaths ?? []),
                    candidate,
                ]);
            } catch {
                continue;
            }
        }
        return buildRuntime(undefined);
    })();

    if (runtime.status !== 'protected') {
        const reason = runtime.status === 'unavailable' ? runtime.reason : 'disabled';
        throw new Error(`checkpoint protection unavailable: ${reason}`);
    }

    const turnWorkspace = new CheckpointTurnWorkspace(canonicalCheckpointRoot);
    // specs/linux-checkpoint-enforcement-backend R3/R8 — bubblewrap cannot enforce glob deny
    // entries (it only leaves ws/** mount-point residue) and refuses to start when a deny entry is
    // a symlink inside the writable workspace. The passthrough target is already read-only through
    // the root ro-bind, so dropping these two kinds on Linux removes no guarantee. The selection is
    // by *source* (pattern-derived entries, passthrough entries), never by inspecting literal paths:
    // a project path may legitimately contain '[' or '?'.
    const linux = input.platform === 'linux';
    const patternEntries = (root: string) => runtime.excludedPatterns.map((pattern) => join(root, pattern));
    const sandboxConfigFor = (path: string): SandboxConfig => ({
        ...inputSandboxConfig,
        sessionIsolation: 'custom',
        customWritePaths: [path],
        denyWritePaths: [...new Set([
            ...inputSandboxConfig.denyWritePaths,
            ...(linux
                ? runtime.denyWritePaths.filter((entry) => !patternEntries(canonicalProjectPath).includes(entry))
                : runtime.denyWritePaths),
            ...runtime.excludedPaths
                .filter((excludedPath) => !linux || !runtime.readOnlyPassthroughPaths.includes(excludedPath))
                .map((excludedPath) => join(path, excludedPath)),
            ...(linux ? [] : patternEntries(path)),
            canonicalProjectPath,
        ])],
    });
    const claudeSandboxFor = (config: SandboxConfig, path: string): QueryOptions['sandbox'] => {
        // 최초 생성과 턴 회전이 같은 함수를 지나므로, 여기 policy 를 넣으면 두 경로가
        // 함께 floor 와 쓰기 범위 검사를 받는다.
        const sandboxRuntime = buildSandboxRuntimeConfig(config, path, policyMode);
        return {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            enableWeakerNetworkIsolation: sandboxRuntime.enableWeakerNetworkIsolation,
            network: sandboxRuntime.network,
            filesystem: sandboxRuntime.filesystem,
        };
    };
    let nextOperationId = randomUUID();
    let providerPath = (await turnWorkspace.reserve({ ...workspaceBinding, operationId: nextOperationId })).path;
    const sandboxConfig = sandboxConfigFor(providerPath);
    const claudeSandbox: QueryOptions['sandbox'] | undefined = input.provider === 'claude-remote'
        ? claudeSandboxFor(sandboxConfig, providerPath)
        : undefined;
    const rotateProviderPath = async () => {
        nextOperationId = randomUUID();
        providerPath = (await turnWorkspace.reserve({ ...workspaceBinding, operationId: nextOperationId })).path;
        Object.assign(sandboxConfig, sandboxConfigFor(providerPath));
        if (claudeSandbox) Object.assign(claudeSandbox, claudeSandboxFor(sandboxConfig, providerPath));
    };
    let activeTurn: CheckpointTurnPreparation | null = null;
    let frozenWorkspacePath: string | null = null;
    // 'prepared'   — the gate opened the turn but nothing was sent yet, so it is discardable.
    // 'dispatched' — the prompt reached the provider; it may already have written files, so the
    //                workspace is preserved even when the turn ends in an error or a timeout.
    // 'applying'   — freeze/apply has begun; a partial result keeps the sealed copy for a retry.
    let turnPhase: 'idle' | 'prepared' | 'dispatched' | 'applying' = 'idle';
    let acceptsProtectedWriters = false;
    const protectedWriterTree = new CheckpointWriterProcessTree();
    const beforeTurn = async () => {
        if (activeTurn) {
            throw new Error(
                'checkpoint protected turn is already active — the previous turn did not finish; '
                + 'restart the session to open a new one',
            );
        }
        const operationId = nextOperationId;
        const currentProtection = await protectionState.read({
            ...workspaceBinding,
            projectPath: canonicalProjectPath,
        });
        if (currentProtection.protection.status !== 'protected') {
            throw new Error('checkpoint protection unavailable: excluded-path');
        }
        if (currentProtection.pendingDecision) {
            throw new Error('checkpoint excluded path decision is pending');
        }
        let snapshot;
        try {
            snapshot = await runtime.beforeTurn(operationId);
        } catch (error) {
            if (error instanceof CheckpointPolicyDriftError) {
                await protectionState.reportPending({
                    ...workspaceBinding,
                    projectPath: canonicalProjectPath,
                    operationId,
                    source: 'policy-drift',
                    excluded: error.excluded,
                    diagnostic: error.diagnostic,
                });
            }
            throw error;
        }
        Object.assign(sandboxConfig, sandboxConfigFor(providerPath));
        if (claudeSandbox) Object.assign(claudeSandbox, claudeSandboxFor(sandboxConfig, providerPath));
        await checkpointEvents.snapshot({
            operationId,
            checkpointId: snapshot.checkpointId,
            excluded: runtime.excludedPaths.map((path) => ({
                path,
                reason: excludedReasonFor(runtime, path),
            })),
        });
        const workspace = await turnWorkspace.prepare({
            ...workspaceBinding,
            operationId,
            checkpointId: snapshot.checkpointId,
            projectPath: canonicalProjectPath,
            readOnlyPassthroughPaths: runtime.readOnlyPassthroughPaths,
        });
        activeTurn = {
            operationId,
            checkpointId: snapshot.checkpointId,
            providerPath: workspace.path,
            sandboxConfig,
            claudeSandbox,
        };
        acceptsProtectedWriters = true;
        turnPhase = 'prepared';
        return activeTurn;
    };
    const protectedBashCwd = () => acceptsProtectedWriters ? activeTurn?.providerPath ?? null : null;
    const completeTurn = async (quiesceWriters: () => Promise<void>) => {
        if (!activeTurn) {
            throw new Error('checkpoint protected turn is not active');
        }
        acceptsProtectedWriters = false;
        await quiesceWriters();
        await protectedWriterTree.quiesce(() => {});
        // Only once the writers are quiescent: a failed quiesce leaves the turn dispatched (its work
        // is preserved) rather than stuck in a phase that neither aborts nor completes.
        turnPhase = 'applying';
        const completedTurn = activeTurn;
        if (!frozenWorkspacePath) {
            frozenWorkspacePath = (await turnWorkspace.freeze({
                ...workspaceBinding,
                operationId: completedTurn.operationId,
            })).path;
        }
        const candidateGuard = await CheckpointExclusionGuard.create({
            ...protection,
            projectPath: frozenWorkspacePath,
            readOnlyPassthroughPaths: [],
            omittedPaths: runtime.readOnlyPassthroughPaths,
            captureContent: false,
        });
        const currentGuard = await CheckpointExclusionGuard.create({
            ...protection,
            projectPath: canonicalProjectPath,
            readOnlyPassthroughPaths: [],
            captureContent: false,
        });
        const applyExclusions = new Map([
            ...currentGuard.manifest.excluded,
            ...candidateGuard.manifest.excluded,
            ...runtime.excludedPaths.map((path) => ({ path, reason: excludedReasonFor(runtime, path) })),
        ].map((entry) => [entry.path, entry]));
        const result = await new CheckpointTurnApplier(canonicalCheckpointRoot).execute({
            ...workspaceBinding,
            operationId: completedTurn.operationId,
            checkpointId: completedTurn.checkpointId,
            projectPath: canonicalProjectPath,
            workspacePath: frozenWorkspacePath,
            excludedPaths: [...applyExclusions.keys()],
            excludedPatterns: runtime.excludedPatterns,
            readOnlyPassthroughPaths: runtime.readOnlyPassthroughPaths,
        });
        const excluded = result.entries.flatMap((entry) => {
            if (entry.action !== 'conflict') return [];
            const reason = [...applyExclusions.values()].find((item) => (
                item.path === entry.path || entry.path.startsWith(`${item.path}/`)
            ))?.reason ?? runtime.excludedReason(entry.path);
            return reason ? [{ path: entry.path, reason }] : [];
        });
        if (excluded.length > 0) {
            const summarized = new Map(excluded.map(entry => {
                const parent = excluded.length > 100 && entry.reason === 'ignored'
                    ? [...applyExclusions.values()].find(item => item.reason === 'ignored' && entry.path.startsWith(`${item.path}/`))
                    : undefined;
                const item = parent ?? entry;
                return [item.path, item];
            }));
            const displayed = [...summarized.values()].sort((left, right) => left.path.localeCompare(right.path)).slice(0, 10_000);
            await protectionState.reportPending({
                ...workspaceBinding,
                projectPath: canonicalProjectPath,
                operationId: completedTurn.operationId,
                source: 'turn-apply',
                excluded: displayed,
                diagnostic: { changes: checkpointExclusionChanges(
                    runtime.excludedPaths.map(path => ({ path, reason: excludedReasonFor(runtime, path) })),
                    [...applyExclusions.values()], displayed.map(entry => entry.path),
                ).slice(0, 100), counts: {
                    capturedFiles: candidateGuard.manifest.capturedFiles.length,
                    capturedBytes: candidateGuard.manifest.capturedFiles.reduce((sum, file) => sum + file.size, 0),
                    excludedFiles: applyExclusions.size, totalChanges: excluded.length,
                } },
            });
        }
        if (result.status === 'completed') {
            await turnWorkspace.remove({
                ...workspaceBinding,
                operationId: completedTurn.operationId,
            });
            activeTurn = null;
            frozenWorkspacePath = null;
            turnPhase = 'idle';
            await rotateProviderPath();
        }
        return result;
    };
    const trackProtectedWriter = (child: ChildProcess) => protectedWriterTree.track(child);
    const markTurnDispatched = () => {
        if (turnPhase === 'prepared') turnPhase = 'dispatched';
    };
    // specs/linux-checkpoint-enforcement-backend R4 — the gate opens the turn before the provider
    // process exists, so a turn that is never dispatched (reconnect failure, refused turn, session
    // exit) has to be discarded: its snapshot stays in the store as history, but the materialized
    // workspace is removed and the writable path rotates so it is never reused.
    const abortTurn = async () => {
        // Only a turn that never reached apply is discardable. A partial apply keeps its sealed
        // workspace and operation id so the journal can retry the failed files.
        if (!activeTurn || turnPhase !== 'prepared') return;
        const abandoned = activeTurn;
        acceptsProtectedWriters = false;
        await protectedWriterTree.quiesce(() => {});
        // Deleting is best effort: a leftover directory is recoverable, but failing to rotate would
        // wedge the session on 'checkpoint protected turn is already active'.
        try {
            await turnWorkspace.remove({ ...workspaceBinding, operationId: abandoned.operationId });
        } finally {
            activeTurn = null;
            frozenWorkspacePath = null;
            turnPhase = 'idle';
            await rotateProviderPath();
        }
    };
    // specs/linux-checkpoint-enforcement-backend R4 — reserve() leaves an empty directory for the next
    // turn; a session that ends without starting it must not leak that directory.
    const dispose = async () => {
        if (activeTurn) return;
        await turnWorkspace.remove({ ...workspaceBinding, operationId: nextOperationId });
    };
    if (input.provider !== 'claude-remote') {
        return {
            sandboxConfig,
            get providerPath() { return providerPath; },
            beforeTurn,
            completeTurn,
            protectedBashCwd,
            trackProtectedWriter,
            dispose,
            abortTurn,
            markTurnDispatched,
        };
    }

    return {
        sandboxConfig,
        get providerPath() { return providerPath; },
        beforeTurn,
        completeTurn,
        protectedBashCwd,
        trackProtectedWriter,
        dispose,
        abortTurn,
        markTurnDispatched,
        claudeSandbox,
    };
}

function excludedReasonFor(
    runtime: Extract<Awaited<ReturnType<typeof createCheckpointRuntime>>, { status: 'protected' }>,
    path: string,
): 'secret' | 'ignored' | 'too-large' | 'file-limit' | 'total-size-limit' {
    const reason = runtime.excludedReason(path);
    if (!reason) throw new Error('checkpoint excluded conflict is missing from the policy');
    return reason;
}
