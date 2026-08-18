import type {
    ResumeSessionOptions,
    SpawnSessionOptions,
} from '@/modules/common/registerCommonHandlers';

export function buildResumeFallbackSpawnOptions(
    options: ResumeSessionOptions | undefined,
): SpawnSessionOptions | null {
    const fallback = options?.fallback;
    if (!fallback) {
        return null;
    }

    return {
        directory: fallback.directory,
        approvedNewDirectoryCreation: false,
        agent: fallback.agent,
        modelMode: options?.model,
        permissionMode: options?.permissionMode,
        effortLevel: options?.effort,
        ...(fallback.agent === 'claude'
            ? { resumeClaudeSessionId: fallback.agentSessionId }
            : { resumeCodexThreadId: fallback.agentSessionId }),
    };
}
