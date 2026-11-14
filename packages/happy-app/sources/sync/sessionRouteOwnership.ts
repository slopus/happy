export type SessionRouteOwner = Readonly<{
    sessionId: string;
    ownerEpoch: number;
    phase: 'opening' | 'interactive' | 'terminal';
    initialPosition?: 'latest' | 'restore';
}>;

export class SessionRouteAbandonedError extends Error {
    constructor() {
        super('Session route abandoned');
    }
}

/** Coordination exhausted its one same-owner recovery, not a network retry. */
export class SessionRouteCoordinationError extends Error {
    constructor() {
        super('Session latest page was not committed after recovery');
        this.name = 'SessionRouteCoordinationError';
    }
}

/** Route retention is independent of the interactive read/unread state. */
export class SessionRouteOwnership {
    private owner: SessionRouteOwner | null = null;
    private nextEpoch = 0;
    private lastSessionId: string | null = null;
    private entryPending = true;

    enter(sessionId: string): SessionRouteOwner {
        if (this.lastSessionId !== sessionId) {
            this.lastSessionId = sessionId;
            this.entryPending = true;
        }
        return this.owner = { sessionId, ownerEpoch: ++this.nextEpoch, phase: 'opening',
            initialPosition: this.entryPending ? 'latest' : 'restore' };
    }

    opened(owner: SessionRouteOwner) {
        if (this.owns(owner)) this.entryPending = false;
    }

    resetEntryPosition() { this.lastSessionId = null; this.entryPending = true; }

    promote(owner: SessionRouteOwner): SessionRouteOwner | null {
        if (!this.owns(owner) || this.owner?.phase === 'terminal') return null;
        return this.owner = { ...owner, phase: 'interactive' };
    }

    terminalize(owner: SessionRouteOwner): SessionRouteOwner | null {
        if (!this.owns(owner)) return null;
        return this.owner = { ...owner, phase: 'terminal' };
    }

    current(): SessionRouteOwner | null {
        return this.owner;
    }

    owns(owner: SessionRouteOwner): boolean {
        return this.owner?.sessionId === owner.sessionId && this.owner.ownerEpoch === owner.ownerEpoch;
    }

    ownsSession(sessionId: string): boolean {
        return this.owner?.sessionId === sessionId;
    }

    leave(owner: SessionRouteOwner): boolean {
        if (!this.owns(owner)) return false;
        this.owner = null;
        return true;
    }
}
