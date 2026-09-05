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
};

export function resolveNewSessionSpawnSettings(args: {
    draftWorktreeKey: string | null;
    resolvedModes: ResolvedNewSessionModes;
    liveSelection: LiveNewSessionSelection | null | undefined;
}) {
    const { draftWorktreeKey, resolvedModes, liveSelection } = args;

    return {
        permissionMode: liveSelection?.permissionKey ?? resolvedModes.permissionMode,
        modelMode: liveSelection?.modelKey ?? resolvedModes.modelMode,
        effortLevel: liveSelection ? liveSelection.effortKey : resolvedModes.effortLevel,
        worktreeKey: liveSelection?.worktreeKey ?? draftWorktreeKey,
        fastMode: liveSelection?.fastMode ?? false,
    };
}
