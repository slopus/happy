import type { ChildProcess } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import type { SandboxConfig } from '@/persistence';
import type { SandboxPolicyMode } from '@/sandbox/sandboxPolicy';
import type { QueryOptions } from '@/claude/sdk';
import { readCheckpointSpawnContext } from './checkpointSpawnContext';
import type { CheckpointProvider } from './checkpointExclusionPolicy';
import type { CheckpointEventPublisher } from './checkpointEventPublisher';
import {
    createCheckpointLocalHistory,
    resolveCheckpointLocalHistoryCapability,
    type CheckpointLocalHistory,
} from './checkpointLocalHistory';
import { CheckpointProtectionStateStore } from './checkpointProtectionState';

/** The isolated-turn apply outcome providers still type against; local history never produces one. */
export type CheckpointTurnApplyResult = { status: 'completed' | 'partial' };

export type CheckpointTurnPreparation = {
    operationId: string;
    checkpointId: string;
    providerPath: string;
    sandboxConfig?: SandboxConfig;
    claudeSandbox?: QueryOptions['sandbox'];
};

export type CheckpointSessionComposition = {
    sandboxConfig: SandboxConfig | undefined;
    /** specs/checkpoint-local-history — turn-boundary records of the original folder. */
    localHistory?: CheckpointLocalHistory;
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
     * 생략하면 개인 머신(owner-choice). Local history 는 provider 의 sandbox 설정을
     * 바꾸지 않으므로 이 값은 런처가 그대로 쓴다.
     */
    sandboxPolicyMode?: SandboxPolicyMode;
}): Promise<CheckpointSessionComposition> {
    const inputSandboxConfig = input.sandboxConfig;
    const protection = inputSandboxConfig?.checkpointProtection;
    if (!protection) return { sandboxConfig: input.sandboxConfig };
    const context = readCheckpointSpawnContext(input.env);
    if (!context) {
        throw new Error('checkpoint protection requires authoritative checkpoint spawn context');
    }
    const capability = resolveCheckpointLocalHistoryCapability(input);
    if (!capability.supported) {
        throw new Error(`checkpoint protection unavailable: ${capability.reason}`);
    }
    await mkdir(context.checkpointRoot, { recursive: true, mode: 0o700 });
    const canonicalCheckpointRoot = await realpath(context.checkpointRoot);
    const canonicalProjectPath = await realpath(input.projectPath);
    const binding = {
        sessionId: input.sessionId,
        projectId: context.projectId,
        worktreeId: context.worktreeId,
    };
    const protectionState = new CheckpointProtectionStateStore(canonicalCheckpointRoot);
    const persisted = await protectionState.read({ ...binding, projectPath: canonicalProjectPath });
    if (persisted.protection.status === 'unavailable') {
        const { checkpointProtection: _checkpointProtection, ...unprotectedSandbox } = inputSandboxConfig;
        return { sandboxConfig: unprotectedSandbox };
    }
    const checkpointEvents = input.checkpointEvents;
    if (!checkpointEvents) {
        throw new Error('checkpoint protection requires a durable event publisher');
    }
    // An older runtime could leave an excluded-path decision pending; local history never asks one.
    if (persisted.pendingDecision) {
        await protectionState.clearPending({ ...binding, projectPath: canonicalProjectPath });
    }
    return {
        sandboxConfig: inputSandboxConfig,
        localHistory: createCheckpointLocalHistory({
            binding,
            checkpointRoot: canonicalCheckpointRoot,
            projectPath: canonicalProjectPath,
            secretPatterns: protection.secretPatterns,
            checkpointEvents,
        }),
    };
}
