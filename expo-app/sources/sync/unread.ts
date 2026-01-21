export function hasUnreadMessages(params: {
    lastViewedAt: number | undefined;
    messages: Array<{ createdAt: number }> | null | undefined;
}): boolean {
    const { lastViewedAt, messages } = params;
    if (lastViewedAt === undefined) return false;
    if (!messages || messages.length === 0) return false;

    const first = messages[0];
    const last = messages[messages.length - 1];
    const latestCreatedAt = first && last ? Math.max(first.createdAt, last.createdAt) : first?.createdAt;
    if (typeof latestCreatedAt !== 'number' || !Number.isFinite(latestCreatedAt)) return false;

    return latestCreatedAt > lastViewedAt;
}

