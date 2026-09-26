/**
 * Guards that make resume-happy-session idempotent.
 *
 * 2026-08-05 incident: two resume RPCs 6.7 seconds apart each spawned a CLI
 * process for the same happy session. Two children attached to one session
 * corrupt each other's runtime reports and get empty-reaped together. A resume
 * request must reuse a live child, and concurrent requests must share one
 * in-flight spawn.
 */

import { realpath } from 'node:fs/promises';

/**
 * True when a daemon child with a running process is already attached to the
 * happy session.
 *
 * The tracked-session map alone is not proof of liveness: adopted/external
 * sessions carry no childProcess handle, so no exit event evicts them and only
 * the periodic health check prunes their PID. Answering "already running" for a
 * dead entry would turn a resume into a no-op, so the PID is verified here.
 *
 * `happySessionId` is only set once the child POSTs its session webhook, which
 * can take minutes on a loaded daemon — and the spawn's 60s webhook timeout
 * fails the RPC without killing the child (2026-09-11 incident). A resume spawn
 * therefore also records the session it was launched for as
 * `resumeTargetSessionId`, and that claim counts as attached from spawn onward.
 */
export function hasLiveDaemonChild(
    happySessionId: string,
    trackedSessions: Iterable<{ happySessionId?: string; resumeTargetSessionId?: string; pid: number }>,
    isPidAlive: (pid: number) => boolean,
    ownsUnresolvedJob: (pid: number) => boolean = () => false,
): boolean {
    for (const session of trackedSessions) {
        const attachedTo = session.happySessionId ?? session.resumeTargetSessionId;
        if (attachedTo === happySessionId && (ownsUnresolvedJob(session.pid) || isPidAlive(session.pid))) return true;
    }
    return false;
}

export function decideAutomationResumePreflight(input: {
    resumeInFlight: boolean;
    live: boolean;
    sameDirectory: boolean | null;
}): 'resume' | 'busy' | 'fallback' {
    if (input.resumeInFlight) return 'busy';
    if (input.live && input.sameDirectory === false) return 'fallback';
    if (input.live) return 'busy';
    return 'resume';
}

export async function resolveAutomationDirectoryMatch(
    firstDirectory: string,
    secondDirectory: string,
    resolveRealpath: (path: string) => Promise<string> = realpath,
): Promise<boolean | null> {
    try {
        const [first, second] = await Promise.all([
            resolveRealpath(firstDirectory),
            resolveRealpath(secondDirectory),
        ]);
        return first === second;
    } catch {
        return null;
    }
}

/**
 * Deduplicates concurrent async work by key: callers arriving while a call for
 * the same key is still pending share its promise. The slot is cleared once the
 * call settles, so later calls run fresh.
 */
export function shareInFlight<T>(
    inflight: Map<string, Promise<T>>,
    key: string,
    factory: () => Promise<T>,
): Promise<T> {
    const existing = inflight.get(key);
    if (existing) return existing;

    const promise = factory().finally(() => {
        inflight.delete(key);
    });
    inflight.set(key, promise);
    return promise;
}

/** The control listener starts before network-dependent daemon initialization finishes. */
export function createLaunchReadinessGate() {
    let ready = false;
    return { isReady: () => ready, markReady: () => { ready = true; } };
}
