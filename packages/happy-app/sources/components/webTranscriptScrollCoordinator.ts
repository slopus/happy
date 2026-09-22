export type ScrollDirection = 'older' | 'newer';
export type TranscriptScrollPort = {
    scrollToOffset: (options: { offset: number; animated?: boolean }) => void;
    scrollToIndex: (options: { index: number; animated?: boolean; viewPosition?: number }) => void;
    scrollToEnd: (options: { animated?: boolean }) => void;
};
type HistoryTransaction = { id: number; key: string; direction: ScrollDirection; compensated: boolean; loadingObserved: boolean };

function mark(event: string) {
    if (typeof __DEV__ === 'undefined' || !__DEV__ || typeof performance === 'undefined') return;
    const name = `transcript:${event}`;
    performance.clearMarks(name);
    performance.mark(name);
}

/** Owns Web writes and async lifetimes. User input and history loading are
 * independent: reversing a gesture invalidates compensation, not the fetch. */
export class WebTranscriptScrollCoordinator {
    interaction: 'settled' | 'userScrolling' | 'programmaticJump' = 'settled';
    history: HistoryTransaction | null = null;
    direction: ScrollDirection | undefined;
    private revision = 0;
    private lastActivity = 0;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingRow: { key: string; align: () => void } | null = null;
    private disposed = false;
    onSettled: () => void = () => {};

    constructor(private readonly target: () => TranscriptScrollPort | null) {}

    readonly driver: TranscriptScrollPort = {
        scrollToOffset: options => this.write(() => this.target()?.scrollToOffset?.(options)),
        scrollToIndex: options => this.write(() => this.target()?.scrollToIndex?.(options)),
        scrollToEnd: options => this.write(() => this.target()?.scrollToEnd?.(options)),
    };

    userIntent(direction?: ScrollDirection) {
        this.revision++;
        this.pendingRow = null;
        if (this.history && direction !== this.history.direction) this.history = null;
        this.direction = direction;
        this.interaction = 'userScrolling';
        this.activity();
    }

    beginHistory(key: string, direction: ScrollDirection, explicit = false): number | null {
        if (this.disposed || this.history || (!explicit && (this.interaction !== 'userScrolling'
            || (this.direction !== undefined && this.direction !== direction)))) return null;
        const id = ++this.revision;
        this.history = { id, key, direction, compensated: false, loadingObserved: false };
        mark('history-request');
        return id;
    }

    observeLoading(loading: boolean) {
        if (!this.history) return;
        if (loading) this.history.loadingObserved = true;
        else if (this.history.loadingObserved) this.finishHistory(this.history.id);
    }

    compensate(id: number, offset: number): boolean {
        if (!this.history || this.history.id !== id || this.history.compensated || !Number.isFinite(offset)) return false;
        this.history.compensated = true;
        mark('anchor-compensation');
        this.driver.scrollToOffset({ offset: Math.max(0, offset), animated: false });
        return true;
    }

    finishHistory(id: number) {
        if (this.history?.id === id) { mark('history-settled'); this.history = null; this.activity(); }
    }

    jump(key?: string, align?: () => void) {
        this.history = null;
        this.direction = undefined;
        this.interaction = 'programmaticJump';
        this.pendingRow = key && align ? { key, align } : null;
        return ++this.revision;
    }

    rowMounted(key: string) {
        if (this.pendingRow?.key !== key) return;
        const pending = this.pendingRow;
        this.pendingRow = null;
        pending.align();
        this.activity();
    }

    isCurrent(revision: number) { return !this.disposed && revision === this.revision; }
    canCapture() { return !this.disposed && this.interaction === 'settled' && !this.history && !this.pendingRow; }

    activity() {
        if (this.disposed) return;
        this.lastActivity = Date.now();
        if (this.idleTimer !== null) return;
        const check = () => {
            const remaining = 250 - (Date.now() - this.lastActivity);
            if (remaining > 0) { this.idleTimer = setTimeout(check, remaining); return; }
            this.idleTimer = null;
            this.interaction = 'settled';
            if (this.canCapture()) { mark('reading-capture'); this.onSettled(); }
        };
        this.idleTimer = setTimeout(check, 250);
    }

    reset() {
        this.revision++;
        this.history = null;
        this.pendingRow = null;
        this.direction = undefined;
        this.interaction = 'settled';
        if (this.idleTimer !== null) clearTimeout(this.idleTimer);
        this.idleTimer = null;
    }

    activate() { this.disposed = false; }
    dispose() { this.reset(); this.disposed = true; }
    private write(action: () => void) {
        if (this.disposed) return;
        this.interaction = 'programmaticJump';
        action();
        this.activity();
    }
}
