/** Internal launch lifecycle. Observation cancellation never settles a still-running producer. */
export class CodexRuntimeProducerGate {
    private frozen = false;
    private closing = false;
    private exited = false;
    private phase: 'idle' | 'preparing' | 'dispatched' = 'idle';
    private readonly tasks = new Set<Promise<void>>();
    private pendingInputs = 0;
    private readonly observers = new Set<() => void>();
    private shutdownDecision: Promise<'confirmed' | 'blocked'> | null = null;
    private settleShutdown: ((decision: 'confirmed' | 'blocked') => void) | null = null;
    private settledDecision: 'confirmed' | 'blocked' | null = null;

    constructor(private readonly ports: {
        hasUndeliveredInput(): boolean;
        canFreezeInbound(): boolean;
        freezeInbound(): boolean;
        stopLoop(): void;
    }) {}

    blocker(): 'frozen' | 'loop-exited' | 'input-undelivered' | 'turn-preparing' | 'producer-busy' | 'inbound-unavailable' | null {
        if (this.frozen || this.closing) return 'frozen';
        if (this.exited) return 'loop-exited';
        if (this.ports.hasUndeliveredInput()) return 'input-undelivered';
        if (this.phase === 'preparing') return 'turn-preparing';
        if (this.pendingInputs) return 'producer-busy';
        if (!this.ports.canFreezeInbound()) return 'inbound-unavailable';
        return null;
    }

    /** Called after all preflights and provider freeze, in the same synchronous stack. */
    freeze(): void {
        if (this.frozen) throw new Error('Runtime input already frozen');
        // The provider has already committed. Even a changed/throwing preflight must close admission.
        let blocker: ReturnType<CodexRuntimeProducerGate['blocker']>;
        try { blocker = this.blocker(); }
        finally {
            this.frozen = true;
            this.shutdownDecision = new Promise(resolve => { this.settleShutdown = resolve; });
            this.settledDecision = null;
        }
        if (blocker) throw new Error('Runtime freeze precondition changed');
        if (!this.ports.freezeInbound()) throw new Error('Inbound freeze refused after provider commit');
        this.ports.stopLoop();
    }

    /** Track a whole producer, including its final writes. Those writes must not re-admit individually.
     * 'writer' permits an existing producer to finish across freeze; it never admits a new one after freeze. */
    admit<T>(work: () => Promise<T>, kind: 'input' | 'writer' = 'input'): Promise<T> {
        if (this.isClosed()) return Promise.reject(new Error('Runtime input is closed'));
        // Reserve before invoking work, including reentrant shutdown from its synchronous prefix.
        let finish!: () => void;
        const tracked = new Promise<void>(resolve => { finish = resolve; });
        this.tasks.add(tracked);
        if (kind === 'input') this.pendingInputs += 1;
        let result: Promise<T>;
        try { result = Promise.resolve(work()); }
        catch (error) { result = Promise.reject(error); }
        const settled = () => { this.tasks.delete(tracked); if (kind === 'input') this.pendingInputs -= 1; finish(); this.notify(); };
        void result.then(settled, settled);
        return result;
    }

    /** Ordinary loop cleanup: seal admission, then await actual producers without asserting provider freeze. */
    async closeAdmissionAndWait(): Promise<void> {
        this.beginTermination();
        await Promise.all([...this.tasks]);
    }

    /** Seal a direct kill before its first await so a drain cannot freeze behind it. */
    beginTermination(): void { this.closing = true; }

    isFrozen(): boolean { return this.frozen; }

    /** A frozen loop may release storage ownership only after the coordinator confirms it. */
    waitForShutdownDecision(): Promise<'confirmed' | 'blocked'> {
        if (!this.shutdownDecision) return Promise.reject(new Error('Runtime input is not frozen'));
        return this.shutdownDecision;
    }

    confirmShutdownStorage(): void {
        this.decideShutdown('confirmed');
    }

    blockShutdownStorage(): void {
        this.decideShutdown('blocked');
    }

    isShutdownBlocked(): boolean { return this.settledDecision === 'blocked'; }

    private decideShutdown(decision: 'confirmed' | 'blocked'): void {
        if (!this.settleShutdown) throw new Error('Runtime input is not frozen');
        if (this.settledDecision && this.settledDecision !== decision) throw new Error('Runtime shutdown decision already settled');
        if (!this.settledDecision) { this.settledDecision = decision; this.settleShutdown(decision); }
    }

    isClosed(): boolean { return this.frozen || this.closing || this.exited; }

    tryBeginPreparing(): boolean {
        if (this.isClosed() || this.phase !== 'idle') return false;
        this.phase = 'preparing';
        return true;
    }
    beginPreparing(): void {
        if (!this.tryBeginPreparing()) throw new Error('Cannot prepare a runtime turn');
    }
    markDispatched(): void {
        if (this.isClosed() || this.phase !== 'preparing') throw new Error('Cannot dispatch a runtime turn');
        this.phase = 'dispatched';
    }
    /** Must follow the turn finally's last storage write, not the provider terminal event. */
    endTurn(): void { this.phase = 'idle'; this.notify(); }
    /** Must follow all loop writes; it is not evidence that the OS runtime process exited. */
    loopExited(): void { this.exited = true; this.notify(); }
    hasLiveProducers(): boolean { return !this.exited || this.phase !== 'idle' || this.tasks.size > 0; }

    quiesce(signal: AbortSignal): Promise<void> {
        if (!this.frozen) return Promise.reject(new Error('Runtime input is not frozen'));
        return new Promise((resolve, reject) => {
            const cleanup = () => { this.observers.delete(check); signal.removeEventListener('abort', check); };
            const check = () => {
                if (signal.aborted) { cleanup(); reject(new Error('Runtime observation aborted')); }
                else if (!this.hasLiveProducers()) { cleanup(); resolve(); }
            };
            this.observers.add(check); signal.addEventListener('abort', check, { once: true }); check();
        });
    }
    private notify(): void { for (const observer of [...this.observers]) observer(); }
}
