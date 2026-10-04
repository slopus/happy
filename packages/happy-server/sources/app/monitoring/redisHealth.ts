// Observability for the Socket.IO cluster bus (Redis streams adapter).
//
// Why this exists: the bus can die completely while every existing health
// signal stays green. In the 2026-08-07 incident the ioredis client stayed
// pinned to a demoted replica after a Sentinel failover, so every XADD came
// back -READONLY and XREAD read a stream that no longer advanced. The pods
// were 1/1 Ready, CPU was normal and the DB pool was fine, so no alert fired
// — but with replicas=2 half of every daemon lookup silently returned "not
// available" because ClusterAdapter.fetchSockets() resolves with local-only
// results (no error, no timeout) when serverCount() is 1.
//
// Everything on the failure path is swallowed by libraries:
//   - socket.io-adapter `publish()` catches XADD rejections into debug()
//   - the streams adapter poll loop catches XREAD rejections into debug()
// so the failures have to be captured here to be visible at all.

const READONLY = 'READONLY';
const KNOWN_REPLY_PREFIXES = [READONLY, 'LOADING', 'MASTERDOWN', 'NOREPLICAS', 'CLUSTERDOWN'];

/** Short, low-cardinality metric label for a Redis failure. */
export function redisErrorCode(error: unknown): string {
    if (typeof error !== 'object' || error === null) return 'UNKNOWN';
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
        if (message === 'Command timed out') return 'TIMEOUT';
        const prefix = KNOWN_REPLY_PREFIXES.find((candidate) => message.startsWith(candidate));
        if (prefix) return prefix;
    }
    return 'UNKNOWN';
}

/** Observe XREAD before the adapter swallows failures, without changing polling. */
export function instrumentStreamReads(
    client: { xread: (...args: any[]) => Promise<any> },
    observe: (result: 'success' | 'failure', seconds: number, error?: unknown) => void,
): void {
    const read = client.xread.bind(client);
    client.xread = async (...args: any[]) => {
        let started: number;
        try {
            started = performance.now();
        } catch {
            // Missing diagnostics must not prevent the Redis command itself.
            return read(...args);
        }
        const report = (result: 'success' | 'failure', error?: unknown) => {
            try {
                const seconds = Math.max(0, performance.now() - started) / 1000;
                if (result === 'failure') observe(result, seconds, error);
                else observe(result, seconds);
            } catch { /* Observation must not stop the stream reader. */ }
        };
        let value: any;
        try {
            value = await read(...args);
        } catch (error) {
            report('failure', error);
            throw error;
        }
        report('success');
        return value;
    };
}

/**
 * One log line per key per interval. A stuck bus produces the same failure
 * tens of times per second (875k -READONLY replies over 4h in the incident);
 * logging each one buries the signal it is supposed to surface.
 */
export function createLogThrottle(intervalMs: number, now: () => number = Date.now): (key: string) => boolean {
    const lastLoggedAt = new Map<string, number>();
    return (key: string) => {
        const at = now();
        const previous = lastLoggedAt.get(key);
        if (previous !== undefined && at - previous < intervalMs) return false;
        lastLoggedAt.set(key, at);
        return true;
    };
}

/**
 * Peers this replica can see on the bus, i.e. `serverCount() - 1` (self).
 * Returns -1 when the adapter cannot answer, so "unknown" is distinguishable
 * from a genuine 0. With replicas >= 2, a sustained 0 means the bus is dead.
 */
export async function readClusterPeerCount(adapter: { serverCount?: () => Promise<number> }): Promise<number> {
    if (typeof adapter.serverCount !== 'function') return -1;
    try {
        return (await adapter.serverCount()) - 1;
    } catch {
        return -1;
    }
}

/**
 * Wrap `xadd` so a failed bus write is counted and logged. The wrapper still
 * rejects — callers (the adapter) keep their existing behaviour.
 */
export function instrumentStreamWrites(
    client: { xadd: (...args: any[]) => Promise<any> },
    onFailure: (code: string, error: unknown) => void,
    observe?: (result: 'success' | 'failure', seconds: number) => void,
): void {
    const original = client.xadd.bind(client);
    client.xadd = async (...args: any[]) => {
        let started: number | undefined;
        if (observe) {
            try { started = performance.now(); } catch { /* Run the write even without a clock. */ }
        }
        const report = (result: 'success' | 'failure') => {
            if (started === undefined) return;
            try { observe?.(result, Math.max(0, performance.now() - started) / 1000); }
            catch { /* Observation must not change the write outcome. */ }
        };
        let value: any;
        try {
            value = await original(...args);
        } catch (error) {
            report('failure');
            try { onFailure(redisErrorCode(error), error); }
            catch { /* Keep the original Redis error if diagnostics fail. */ }
            throw error;
        }
        report('success');
        return value;
    };
}
