export type ReadStateV1 = {
    v: 1;
    sessionSeq: number;
    pendingActivityAt: number;
    updatedAt: number;
};

export function computeNextReadStateV1(params: {
    prev: ReadStateV1 | undefined;
    sessionSeq: number;
    pendingActivityAt: number;
    now: number;
}): { didChange: boolean; next: ReadStateV1 } {
    const sessionSeq = params.sessionSeq ?? 0;
    const pendingActivityAt = params.pendingActivityAt ?? 0;

    const prev = params.prev;
    if (!prev) {
        return {
            didChange: true,
            next: { v: 1, sessionSeq, pendingActivityAt, updatedAt: params.now },
        };
    }

    const needsSeqRepair = prev.sessionSeq > sessionSeq;
    const nextSessionSeq = needsSeqRepair
        ? sessionSeq
        : Math.max(prev.sessionSeq, sessionSeq);

    const nextPendingActivityAt = Math.max(prev.pendingActivityAt, pendingActivityAt);

    if (!needsSeqRepair && nextSessionSeq === prev.sessionSeq && nextPendingActivityAt === prev.pendingActivityAt) {
        return { didChange: false, next: prev };
    }

    return {
        didChange: true,
        next: {
            v: 1,
            sessionSeq: nextSessionSeq,
            pendingActivityAt: nextPendingActivityAt,
            updatedAt: params.now,
        },
    };
}

