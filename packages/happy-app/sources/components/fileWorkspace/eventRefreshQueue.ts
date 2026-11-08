/** Coalesce event bursts; a change during a read gets one trailing read, never a timer retry. */
export class EventRefreshQueue {
    private pending = new Set<string>();
    private running = false;
    private disposed = false;
    constructor(private refresh: (path: string) => Promise<void>) {}
    enqueue(paths: string[]) {
        if (this.disposed) return;
        for (const path of paths) this.pending.add(path);
        if (this.running) return;
        this.running = true;
        queueMicrotask(() => { void this.drain(); });
    }
    private async drain() {
        try {
            while (!this.disposed && this.pending.size) {
                const path = this.pending.values().next().value!;
                this.pending.delete(path);
                try { await this.refresh(path); } catch { /* the controller retains the actual error */ }
            }
        } finally { this.running = false; }
    }
    dispose() { this.disposed = true; this.pending.clear(); }
}
