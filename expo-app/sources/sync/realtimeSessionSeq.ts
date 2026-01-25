type UpdateType = 'new-message' | 'update-session';

export function computeNextSessionSeqFromUpdate(params: {
    currentSessionSeq: number;
    updateType: UpdateType;
    containerSeq: number;
    messageSeq: number | undefined;
}): number {
    const { currentSessionSeq, updateType, containerSeq: _containerSeq, messageSeq } = params;

    if (updateType === 'update-session') {
        return currentSessionSeq;
    }

    const candidate = messageSeq;
    if (typeof candidate !== 'number') {
        return currentSessionSeq;
    }

    return Math.max(currentSessionSeq, candidate);
}
