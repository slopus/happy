export type CopyMenuToggleAction = 'expand' | 'collapse';

export function getCopyMenuExpansionState<T extends string | number>({
    target,
    truncatedTargets,
    expandedTargets,
}: {
    target: T;
    truncatedTargets: Set<T>;
    expandedTargets: Set<T>;
}): {
    isLong: boolean;
    toggleAction: CopyMenuToggleAction | null;
} {
    const isLong = truncatedTargets.has(target);

    return {
        isLong,
        toggleAction: !isLong ? null : (expandedTargets.has(target) ? 'collapse' : 'expand'),
    };
}
