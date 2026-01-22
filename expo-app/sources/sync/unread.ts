import type { Metadata } from './storageTypes';

export function computePendingActivityAt(metadata: Metadata | null | undefined): number {
    if (!metadata) return 0;

    let latest = 0;
    const bump = (v: unknown) => {
        if (typeof v !== 'number') return;
        if (!Number.isFinite(v)) return;
        if (v > latest) latest = v;
    };

    const queue = metadata.messageQueueV1?.queue ?? [];
    for (const item of queue) {
        bump(item.updatedAt);
        bump(item.createdAt);
    }

    const inFlight = metadata.messageQueueV1?.inFlight;
    if (inFlight) {
        bump(inFlight.claimedAt);
        bump(inFlight.updatedAt);
        bump(inFlight.createdAt);
    }

    const discarded = metadata.messageQueueV1Discarded ?? [];
    for (const item of discarded) {
        bump(item.discardedAt);
        bump(item.updatedAt);
        bump(item.createdAt);
    }

    return latest;
}

export function computeHasUnreadActivity(params: {
    sessionSeq: number;
    pendingActivityAt: number;
    lastViewedSessionSeq: number | undefined;
    lastViewedPendingActivityAt: number | undefined;
}): boolean {
    const { sessionSeq, pendingActivityAt, lastViewedSessionSeq, lastViewedPendingActivityAt } = params;

    const hasAnyActivity = sessionSeq > 0 || pendingActivityAt > 0;
    const hasMarker = typeof lastViewedSessionSeq === 'number' || typeof lastViewedPendingActivityAt === 'number';
    if (!hasMarker) return hasAnyActivity;

    const viewedSeq = typeof lastViewedSessionSeq === 'number' ? lastViewedSessionSeq : 0;
    const viewedPendingAt = typeof lastViewedPendingActivityAt === 'number' ? lastViewedPendingActivityAt : 0;

    return sessionSeq > viewedSeq || pendingActivityAt > viewedPendingAt;
}
