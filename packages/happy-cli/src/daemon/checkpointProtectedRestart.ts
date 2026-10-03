import type { SandboxConfig } from '@/persistence';
import { CheckpointRefreshRejectedError } from '../checkpoint/checkpointRecovery';

export type CheckpointRestartBinding = {
    sessionId: string;
    projectId: string;
    worktreeId: string | null;
    projectPath: string;
};

type CheckpointRestartTarget = CheckpointRestartBinding & {
    pid: number;
    active: boolean;
    knownStopped: boolean;
    sandboxConfig: SandboxConfig;
    terminate(): Promise<void>;
};

type CheckpointRestartDependencies = {
    resolveTarget(sessionId: string): Promise<CheckpointRestartTarget | null>;
    isProcessAlive(pid: number): boolean;
    resume(
        sessionId: string,
        environmentVariables: Record<string, string>,
    ): Promise<{ type: string; sessionId?: string; errorMessage?: string }>;
};

export function createCheckpointRestartQueue() {
    const pending = new Map<string, { preserveProtection: boolean; promise: Promise<void> }>();
    return (sessionId: string, preserveProtection: boolean, restart: () => Promise<void>): Promise<void> => {
        const previous = pending.get(sessionId);
        if (previous?.preserveProtection === preserveProtection) return previous.promise;
        const execution = previous ? previous.promise.then(restart) : restart();
        const promise = execution.finally(() => {
            if (pending.get(sessionId)?.promise === promise) pending.delete(sessionId);
        });
        pending.set(sessionId, { preserveProtection, promise });
        return promise;
    };
}

export async function restartCheckpointProtectedSession(
    binding: CheckpointRestartBinding,
    dependencies: CheckpointRestartDependencies,
    options: { preserveProtection?: boolean } = {},
): Promise<{ sessionId: string }> {
    const target = await dependencies.resolveTarget(binding.sessionId);
    if (!target) throw new CheckpointRefreshRejectedError('checkpoint protected restart target is unavailable');
    if (
        target.sessionId !== binding.sessionId
        || target.projectId !== binding.projectId
        || target.worktreeId !== binding.worktreeId
        || target.projectPath !== binding.projectPath
    ) {
        throw new CheckpointRefreshRejectedError('checkpoint protected restart binding mismatch');
    }
    if (!target.sandboxConfig.checkpointProtection) {
        throw new CheckpointRefreshRejectedError('checkpoint protected restart target is not protected');
    }
    if (!target.active && !target.knownStopped) {
        throw new CheckpointRefreshRejectedError('checkpoint protected restart cannot prove the previous provider stopped');
    }
    const { checkpointProtection: _checkpointProtection, ...sandboxConfig } = target.sandboxConfig;
    if (target.active && target.pid > 0 && dependencies.isProcessAlive(target.pid)) {
        try { await target.terminate(); }
        catch { throw new CheckpointRefreshRejectedError('checkpoint protected restart target did not stop'); }
        if (dependencies.isProcessAlive(target.pid)) {
            throw new CheckpointRefreshRejectedError('checkpoint protected restart target did not stop');
        }
    }
    const result = await dependencies.resume(binding.sessionId, {
        HAPPY_PROJECT_SANDBOX_CONFIG: JSON.stringify(options.preserveProtection ? target.sandboxConfig : sandboxConfig),
    });
    if (result.type !== 'success' || result.sessionId !== binding.sessionId) {
        throw new Error(result.errorMessage ?? 'checkpoint protected restart failed');
    }
    return { sessionId: result.sessionId };
}
