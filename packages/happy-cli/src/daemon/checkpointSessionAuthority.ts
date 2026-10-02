import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
    CheckpointExclusionGuard,
    resolveCheckpointProtectionCapability,
} from '@/checkpoint/checkpointExclusionPolicy';
import type { CheckpointRpcSessionAuthority } from '@/checkpoint/checkpointRpc';
import { CheckpointProtectionStateStore } from '@/checkpoint/checkpointProtectionState';
import { readCheckpointSpawnContext } from '@/checkpoint/checkpointSpawnContext';
import type { TrackedSession } from './types';

export async function resolveCheckpointSessionAuthority(input: {
    sessionId: string;
    trackedSession: TrackedSession | undefined;
    checkpointRoot: string;
    platform: NodeJS.Platform;
    isProcessAlive?: (pid: number) => boolean;
}): Promise<CheckpointRpcSessionAuthority | null> {
    const tracked = input.trackedSession;
    if (
        !tracked
        || tracked.happySessionId !== input.sessionId
        || !tracked.directory
    ) return null;
    const context = readCheckpointSpawnContext(tracked.agentEnvironment ?? {});
    if (!context || resolve(context.checkpointRoot) !== resolve(input.checkpointRoot)) return null;

    const projectPath = await realpath(tracked.directory);
    const checkpointProtection = tracked.happySessionMetadataFromLocalWebhook
        ?.sandbox?.checkpointProtection;
    const base = {
        sessionId: input.sessionId,
        projectId: context.projectId,
        worktreeId: context.worktreeId,
        projectPath,
    };
    if (!checkpointProtection) {
        return {
            ...base,
            protection: { status: 'legacy' },
            pendingDecision: null,
            excludedPaths: [],
            excludedPatterns: [],
            canRestoreHistory: false,
        };
    }

    const flavor = tracked.happySessionMetadataFromLocalWebhook?.flavor;
    const provider = flavor === 'claude' ? 'claude-remote' : flavor ?? 'unknown';
    const capability = resolveCheckpointProtectionCapability({
        platform: input.platform,
        provider,
    });
    if (!capability.supported) {
        return {
            ...base,
            protection: { status: 'unavailable', reason: capability.reason },
            pendingDecision: null,
            excludedPaths: [],
            excludedPatterns: [],
        };
    }

    try {
        const persisted = await new CheckpointProtectionStateStore(input.checkpointRoot).read(base);
        if (persisted.protection.status === 'unavailable') {
            return {
                ...base,
                protection: persisted.protection,
                pendingDecision: null,
                excludedPaths: [],
                excludedPatterns: [],
            };
        }
        const guard = await CheckpointExclusionGuard.create({
            projectPath,
            ...checkpointProtection,
            captureContent: false,
        });
        return {
            ...base,
            protection: { status: 'protected' },
            pendingDecision: persisted.pendingDecision,
            excludedPaths: guard.manifest.excluded.map((entry) => entry.path),
            excludedPatterns: guard.secretPatterns,
            limits: { maxFileBytes: checkpointProtection.maxFileBytes, maxFiles: checkpointProtection.maxFiles,
                maxTotalBytes: checkpointProtection.maxTotalBytes },
        };
    } catch {
        return {
            ...base,
            protection: { status: 'unavailable', reason: 'snapshot-failed' },
            pendingDecision: null,
            excludedPaths: [],
            excludedPatterns: [],
        };
    }
}
