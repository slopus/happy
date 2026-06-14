import type { Metadata } from './storageTypes';

export type RunReviewActionKind = 'accepted' | 'flagged' | 'note';

export type RunReviewActionEvent = {
    id: string;
    kind: RunReviewActionKind;
    note?: string;
    createdAt: number;
};

export const RUN_REVIEW_CLOCK_INTERVAL_MS = 30 * 1000;

export function getRunReviewEvents(metadata: Metadata | null | undefined): RunReviewActionEvent[] {
    return metadata?.runReviewEvents ?? [];
}

export function getFinalRunReviewEvent(events: RunReviewActionEvent[]): RunReviewActionEvent | null {
    return [...events].reverse().find((event) => event.kind === 'accepted' || event.kind === 'flagged') ?? null;
}

export function createRunReviewEvent(kind: RunReviewActionKind, now: number, note?: string): RunReviewActionEvent {
    const trimmed = note?.trim();
    return {
        id: `run-review-${now}-${Math.random().toString(36).slice(2, 10)}`,
        kind,
        ...(trimmed ? { note: trimmed } : {}),
        createdAt: now,
    };
}

export function appendRunReviewEvent(
    events: RunReviewActionEvent[],
    event: RunReviewActionEvent,
): RunReviewActionEvent[] {
    if (event.kind === 'flagged' && !event.note?.trim()) {
        throw new Error('Flagged run review events require a note.');
    }
    if ((event.kind === 'accepted' || event.kind === 'flagged') && getFinalRunReviewEvent(events)) {
        return events;
    }
    return [...events, event];
}
