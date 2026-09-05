export class SessionMessageRetention {
    private readonly recency = new Map<string, true>();

    constructor(private readonly capacity: number) {}

    touch(sessionId: string): string[] {
        this.recency.delete(sessionId);
        this.recency.set(sessionId, true);

        const evicted: string[] = [];
        while (this.recency.size > this.capacity) {
            const leastRecentlyUsed = this.recency.keys().next().value as string | undefined;
            if (leastRecentlyUsed === undefined) break;
            this.recency.delete(leastRecentlyUsed);
            evicted.push(leastRecentlyUsed);
        }
        return evicted;
    }

    retainedSessionIds(): string[] {
        return [...this.recency.keys()];
    }

    remove(sessionId: string): void {
        this.recency.delete(sessionId);
    }

}
