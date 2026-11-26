import type { ActivityDay, ActivityMonth } from './codexActivityCalendar';

export const ACTIVITY_CELL_SIZE = 13;
export const ACTIVITY_GAP = 3;
export const ACTIVITY_PITCH = ACTIVITY_CELL_SIZE + ACTIVITY_GAP;
export const ACTIVITY_LEVEL_ALPHA = [0, 0.3, 0.52, 0.76, 1] as const;

export type ActivityMetricKey = 'input' | 'cache' | 'output';
export type MetricKey = ActivityMetricKey;

export interface ActivityMetric {
    readonly key: ActivityMetricKey;
    readonly value: number;
}

/** Disjoint token categories: input already includes cache, output includes reasoning. */
export function getActivityMetrics(day: ActivityDay): readonly ActivityMetric[] {
    return [
        { key: 'input', value: Math.max(0, day.inputTokens - day.cachedInputTokens) },
        { key: 'cache', value: day.cachedInputTokens },
        { key: 'output', value: day.outputTokens },
    ];
}

/** Prefer the following month when a short leading month leaves too little label space. */
export function filterActivityMonths(
    months: readonly ActivityMonth[],
    pitch = ACTIVITY_PITCH,
    minSpacing = 28,
): ActivityMonth[] {
    return months.filter((month, index) => (
        index === months.length - 1
        || (months[index + 1].weekIndex - month.weekIndex) * pitch >= minSpacing
    ));
}
