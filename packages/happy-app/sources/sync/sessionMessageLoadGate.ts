export type SessionMessageLease = Readonly<{
    sessionId: string;
    leaseEpoch: number;
}>;

export type SessionMessageLoadOperation = Readonly<{
    sessionId: string;
    leaseEpoch: number;
    loadEpoch: number;
}>;

export class SessionMessageLoadGate {
    private readonly leases = new Map<string, SessionMessageLease>();
    private readonly loadEpochs = new Map<string, number>();
    private nextLeaseEpoch = 0;
    private nextLoadEpoch = 0;

    enter(sessionId: string): SessionMessageLease {
        const lease = { sessionId, leaseEpoch: ++this.nextLeaseEpoch };
        this.leases.set(sessionId, lease);
        this.loadEpochs.delete(sessionId);
        return lease;
    }

    currentLease(sessionId: string): SessionMessageLease | null {
        return this.leases.get(sessionId) ?? null;
    }

    begin(lease: SessionMessageLease): SessionMessageLoadOperation {
        const loadEpoch = ++this.nextLoadEpoch;
        if (this.isLeaseCurrent(lease)) {
            this.loadEpochs.set(lease.sessionId, loadEpoch);
        }
        return {
            sessionId: lease.sessionId,
            leaseEpoch: lease.leaseEpoch,
            loadEpoch,
        };
    }

    invalidate(sessionId: string): void {
        this.leases.delete(sessionId);
        this.loadEpochs.delete(sessionId);
    }

    isLeaseCurrent(lease: SessionMessageLease): boolean {
        return this.leases.get(lease.sessionId) === lease;
    }

    assertLeaseCurrent(lease: SessionMessageLease): void {
        if (!this.isLeaseCurrent(lease)) {
            throw new Error('Session message load abandoned');
        }
    }

    isCurrent(operation: SessionMessageLoadOperation): boolean {
        const lease = this.leases.get(operation.sessionId);
        return lease?.leaseEpoch === operation.leaseEpoch
            && this.loadEpochs.get(operation.sessionId) === operation.loadEpoch;
    }

    assertCurrent(operation: SessionMessageLoadOperation): void {
        if (!this.isCurrent(operation)) {
            throw new Error('Session message load abandoned');
        }
    }

    leave(lease: SessionMessageLease): void {
        if (this.isLeaseCurrent(lease)) {
            this.invalidate(lease.sessionId);
        }
    }
}
