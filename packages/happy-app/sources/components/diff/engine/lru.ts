/** Small, bounded in-memory cache shared by diff documents and syntax results. */
export class LruCache<T> {
    private readonly entries = new Map<string, { value: T; weight: number }>();
    private weight = 0;

    constructor(private readonly limit: number, private readonly maxWeight = Infinity) {}

    get(key: string): T | undefined {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    set(key: string, value: T, weight = 1): void {
        const previous = this.entries.get(key);
        if (previous) this.weight -= previous.weight;
        this.entries.delete(key);
        if (weight > this.maxWeight) return;
        this.entries.set(key, { value, weight });
        this.weight += weight;
        while (this.entries.size > this.limit || this.weight > this.maxWeight) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.weight -= this.entries.get(oldest)!.weight;
            this.entries.delete(oldest);
        }
    }

    clear(): void {
        this.entries.clear();
        this.weight = 0;
    }
}