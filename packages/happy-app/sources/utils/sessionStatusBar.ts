import { maxContextSizeForModel } from './contextWindow';

export const SESSION_STATUS_CONTEXT_MAX = 190000;

export type ContextUsageLevel = 'normal' | 'warning' | 'critical';

export function resolveStatusBarGitBranch(
    gitStatusBranch: string | null | undefined,
    metadataGitBranch: string | null | undefined,
): string | null {
    const gitBranch = gitStatusBranch?.trim();
    if (gitBranch) {
        return gitBranch;
    }

    const metadataBranch = metadataGitBranch?.trim();
    return metadataBranch || null;
}

export function clampContextSize(value: number | null | undefined, maxValue = SESSION_STATUS_CONTEXT_MAX): number {
    if (!Number.isFinite(value) || !Number.isFinite(maxValue) || maxValue <= 0) {
        return 0;
    }

    return Math.min(Math.max(0, value ?? 0), maxValue);
}

export function getContextUsagePercentage(value: number | null | undefined, maxValue = SESSION_STATUS_CONTEXT_MAX): number {
    if (!Number.isFinite(maxValue) || maxValue <= 0) {
        return 0;
    }

    return (clampContextSize(value, maxValue) / maxValue) * 100;
}

export function getContextUsageLevel(value: number | null | undefined, maxValue = SESSION_STATUS_CONTEXT_MAX): ContextUsageLevel {
    const percentage = getContextUsagePercentage(value, maxValue);
    if (percentage >= 95) {
        return 'critical';
    }
    if (percentage >= 90) {
        return 'warning';
    }
    return 'normal';
}

// Size the context window for the usage circle. Prefer the API-reported window,
// but when it's absent (the API echoes only the base model id, so 1M-token
// models don't report their real window) fall back to the selected model key.
// SessionStatusBar previously hardcoded the 190K default here, which reclamped
// [1m] models to ~100% used on a fresh session (regression of #910).
export function resolveContextMaxValue(
    contextWindow: number | null | undefined,
    modelKey?: string | null,
): number {
    if (typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0) {
        return Math.trunc(contextWindow);
    }
    return maxContextSizeForModel(modelKey ?? undefined);
}
