import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { sessionCacheCounter, databaseUpdatesSkippedCounter } from "@/app/monitoring/metrics2";

interface SessionCacheEntry {
    validUntil: number;
    lastUpdateSent: number;
    pendingUpdate: number | null;
    userId: string;
}

interface MachineCacheEntry {
    validUntil: number;
    lastUpdateSent: number;
    pendingUpdate: number | null;
    userId: string;
    active: boolean;
}

class ActivityCache {
    private sessionCache = new Map<string, SessionCacheEntry>();
    private machineCache = new Map<string, MachineCacheEntry>();
    // Sessions that were just stopped, archived or deleted, mapped to the time their
    // heartbeat suppression expires
    private stoppedSessions = new Map<string, number>();
    private batchTimer: ReturnType<typeof setInterval> | null = null;
    
    // Cache TTL (30 seconds)
    private readonly CACHE_TTL = 30 * 1000;
    
    // Only update DB if time difference is significant (30 seconds)
    private readonly UPDATE_THRESHOLD = 30 * 1000;
    
    // Batch update interval (5 seconds)
    private readonly BATCH_INTERVAL = 5 * 1000;

    // How long heartbeats are ignored after a session is stopped (60 seconds).
    // Longer than CACHE_TTL + BATCH_INTERVAL so that every in-flight heartbeat and
    // every pending flush from before the stop is gone by the time it expires.
    private readonly STOPPED_TTL = 60 * 1000;

    constructor() {
        this.startBatchTimer();
    }

    private startBatchTimer(): void {
        if (this.batchTimer) {
            clearInterval(this.batchTimer);
        }
        
        this.batchTimer = setInterval(() => {
            this.flushPendingUpdates().catch(error => {
                log({ module: 'session-cache', level: 'error' }, `Error flushing updates: ${error}`);
            });
        }, this.BATCH_INTERVAL);
    }

    async isSessionValid(sessionId: string, userId: string): Promise<boolean> {
        const now = Date.now();

        // Session was just stopped, archived or deleted - ignore heartbeats for a while
        // instead of caching it again and letting a batch flush revive it
        if (this.isSessionStopped(sessionId, now)) {
            sessionCacheCounter.inc({ operation: 'session_validation', result: 'stopped' });
            return false;
        }

        const cached = this.sessionCache.get(sessionId);
        
        // Check cache first
        if (cached && cached.validUntil > now && cached.userId === userId) {
            sessionCacheCounter.inc({ operation: 'session_validation', result: 'hit' });
            return true;
        }
        
        sessionCacheCounter.inc({ operation: 'session_validation', result: 'miss' });
        
        // Cache miss - check database
        try {
            const session = await db.session.findUnique({
                where: { id: sessionId, accountId: userId }
            });
            
            if (session) {
                // Session could have been stopped while we were reading the database
                if (this.isSessionStopped(sessionId, Date.now())) {
                    sessionCacheCounter.inc({ operation: 'session_validation', result: 'stopped' });
                    return false;
                }

                // Cache the result
                this.sessionCache.set(sessionId, {
                    validUntil: now + this.CACHE_TTL,
                    lastUpdateSent: session.lastActiveAt.getTime(),
                    pendingUpdate: null,
                    userId
                });
                return true;
            }
            
            return false;
        } catch (error) {
            log({ module: 'session-cache', level: 'error' }, `Error validating session ${sessionId}: ${error}`);
            return false;
        }
    }

    async isMachineValid(machineId: string, userId: string): Promise<boolean> {
        const now = Date.now();
        const cached = this.machineCache.get(machineId);
        
        // Check cache first
        if (cached && cached.validUntil > now && cached.userId === userId) {
            sessionCacheCounter.inc({ operation: 'machine_validation', result: 'hit' });
            return true;
        }
        
        sessionCacheCounter.inc({ operation: 'machine_validation', result: 'miss' });
        
        // Cache miss - check database
        try {
            const machine = await db.machine.findUnique({
                where: {
                    accountId_id: {
                        accountId: userId,
                        id: machineId
                    }
                }
            });
            
            if (machine) {
                // Cache the result
                this.machineCache.set(machineId, {
                    validUntil: now + this.CACHE_TTL,
                    lastUpdateSent: machine.lastActiveAt?.getTime() || 0,
                    pendingUpdate: null,
                    userId,
                    active: machine.active
                });
                return true;
            }
            
            return false;
        } catch (error) {
            log({ module: 'session-cache', level: 'error' }, `Error validating machine ${machineId}: ${error}`);
            return false;
        }
    }

    queueSessionUpdate(sessionId: string, timestamp: number): boolean {
        // Heartbeat that was already in flight when the session was stopped
        if (this.isSessionStopped(sessionId, Date.now())) {
            databaseUpdatesSkippedCounter.inc({ type: 'session' });
            return false;
        }

        const cached = this.sessionCache.get(sessionId);
        if (!cached) {
            return false; // Should validate first
        }
        
        // Only queue if time difference is significant
        const timeDiff = Math.abs(timestamp - cached.lastUpdateSent);
        if (timeDiff > this.UPDATE_THRESHOLD) {
            cached.pendingUpdate = timestamp;
            return true;
        }
        
        databaseUpdatesSkippedCounter.inc({ type: 'session' });
        return false; // No update needed
    }

    /**
     * Forget queued heartbeats and ignore new ones before a session is stopped,
     * archived, or deleted. Call this before the deactivating write: dropping the cache
     * entry alone leaves a window where a heartbeat re-validates the session, caches it
     * again and queues an update, and the next batch flush overwrites active=false with
     * stale activity (or updates an already deleted row). Suppression expires by itself
     * after STOPPED_TTL and is lifted early by resumeSessionUpdates.
     */
    clearSessionUpdates(sessionId: string): void {
        this.sessionCache.delete(sessionId);
        this.stoppedSessions.set(sessionId, Date.now() + this.STOPPED_TTL);
    }

    /**
     * Accept heartbeats again for a session that is legitimately starting back up,
     * so a restarted session goes active without waiting out the suppression window.
     */
    resumeSessionUpdates(sessionId: string): void {
        this.stoppedSessions.delete(sessionId);
    }

    private isSessionStopped(sessionId: string, now: number): boolean {
        const stoppedUntil = this.stoppedSessions.get(sessionId);
        if (stoppedUntil === undefined) {
            return false;
        }
        if (stoppedUntil <= now) {
            this.stoppedSessions.delete(sessionId);
            return false;
        }
        return true;
    }

    queueMachineUpdate(machineId: string, timestamp: number): boolean {
        const cached = this.machineCache.get(machineId);
        if (!cached) {
            return false; // Should validate first
        }
        
        // Always persist a heartbeat that flips an inactive machine online.
        // New machines start inactive with lastActiveAt defaulting to "now", so
        // the timestamp threshold alone would skip the first onboarding ping.
        const timeDiff = Math.abs(timestamp - cached.lastUpdateSent);
        if (!cached.active || timeDiff > this.UPDATE_THRESHOLD) {
            cached.pendingUpdate = timestamp;
            return true;
        }
        
        databaseUpdatesSkippedCounter.inc({ type: 'machine' });
        return false; // No update needed
    }

    private async flushPendingUpdates(): Promise<void> {
        const sessionUpdates: { id: string, timestamp: number }[] = [];
        const machineUpdates: { id: string, timestamp: number, userId: string }[] = [];
        
        // Collect session updates
        for (const [sessionId, entry] of this.sessionCache.entries()) {
            if (entry.pendingUpdate) {
                sessionUpdates.push({ id: sessionId, timestamp: entry.pendingUpdate });
                entry.lastUpdateSent = entry.pendingUpdate;
                entry.pendingUpdate = null;
            }
        }
        
        // Collect machine updates
        for (const [machineId, entry] of this.machineCache.entries()) {
            if (entry.pendingUpdate) {
                machineUpdates.push({ 
                    id: machineId, 
                    timestamp: entry.pendingUpdate, 
                    userId: entry.userId 
                });
                entry.lastUpdateSent = entry.pendingUpdate;
                entry.active = true;
                entry.pendingUpdate = null;
            }
        }
        
        // Batch update sessions
        if (sessionUpdates.length > 0) {
            try {
                await Promise.all(sessionUpdates.map(update =>
                    db.session.update({
                        where: { id: update.id },
                        data: { lastActiveAt: new Date(update.timestamp), active: true }
                    })
                ));
                
                log({ module: 'session-cache' }, `Flushed ${sessionUpdates.length} session updates`);
            } catch (error) {
                log({ module: 'session-cache', level: 'error' }, `Error updating sessions: ${error}`);
            }
        }
        
        // Batch update machines
        if (machineUpdates.length > 0) {
            try {
                await Promise.all(machineUpdates.map(update =>
                    db.machine.update({
                        where: {
                            accountId_id: {
                                accountId: update.userId,
                                id: update.id
                            }
                        },
                        data: { lastActiveAt: new Date(update.timestamp), active: true }
                    })
                ));
                
                log({ module: 'session-cache' }, `Flushed ${machineUpdates.length} machine updates`);
            } catch (error) {
                log({ module: 'session-cache', level: 'error' }, `Error updating machines: ${error}`);
            }
        }
    }

    // Cleanup old cache entries periodically
    cleanup(): void {
        const now = Date.now();
        
        for (const [sessionId, entry] of this.sessionCache.entries()) {
            if (entry.validUntil < now) {
                this.sessionCache.delete(sessionId);
            }
        }
        
        for (const [machineId, entry] of this.machineCache.entries()) {
            if (entry.validUntil < now) {
                this.machineCache.delete(machineId);
            }
        }

        for (const [sessionId, stoppedUntil] of this.stoppedSessions.entries()) {
            if (stoppedUntil <= now) {
                this.stoppedSessions.delete(sessionId);
            }
        }
    }

    shutdown(): void {
        if (this.batchTimer) {
            clearInterval(this.batchTimer);
            this.batchTimer = null;
        }
        
        // Flush any remaining updates
        this.flushPendingUpdates().catch(error => {
            log({ module: 'session-cache', level: 'error' }, `Error flushing final updates: ${error}`);
        });
    }
}

// Global instance
export const activityCache = new ActivityCache();

// Cleanup every 5 minutes
setInterval(() => {
    activityCache.cleanup();
}, 5 * 60 * 1000);
