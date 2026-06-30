export const SESSION_STATUS_CONTEXT_MAX = 190000;

export type ContextUsageLevel = 'normal' | 'warning' | 'critical';

export function getPathBasename(path: string | null | undefined): string | null {
    const trimmed = path?.trim();
    if (!trimmed) {
        return null;
    }

    const segments = trimmed.split(/[/\\]/).filter(Boolean);
    if (segments.length === 0) {
        return trimmed;
    }

    return segments[segments.length - 1];
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
