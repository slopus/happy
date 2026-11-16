type ResolvedNewSessionModes = {
    permissionMode?: string | null;
    modelMode?: string | null;
    effortLevel?: string | null;
};

type LiveNewSessionSelection = {
    permissionKey?: string;
    modelKey?: string;
    effortKey?: string | null;
    worktreeKey: string;
    fastMode: boolean;
    expectedCodexAccountProfileId?: string | null;
};

export function resolveNewSessionSpawnSettings(args: {
    draftWorktreeKey: string | null;
    resolvedModes: ResolvedNewSessionModes;
    liveSelection: LiveNewSessionSelection | null | undefined;
}) {
    const { draftWorktreeKey, resolvedModes, liveSelection } = args;

    return {
        permissionMode: liveSelection?.permissionKey ?? resolvedModes.permissionMode,
        // Persist explicit reset sentinels: undefined/null would later fall back
        // to settings or code defaults while the new session is hydrating.
        modelMode: liveSelection ? liveSelection.modelKey ?? 'default' : resolvedModes.modelMode,
        effortLevel: liveSelection ? liveSelection.effortKey ?? 'default' : resolvedModes.effortLevel,
        worktreeKey: liveSelection?.worktreeKey ?? draftWorktreeKey,
        fastMode: liveSelection?.fastMode ?? false,
        ...(liveSelection?.expectedCodexAccountProfileId !== undefined
            ? { expectedCodexAccountProfileId: liveSelection.expectedCodexAccountProfileId } : {}),
    };
}
