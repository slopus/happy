/**
 * Lightweight on-device performance logging for chasing the session-open
 * freeze. Everything goes through console.log with a `[perf]` tag, so it shows
 * in the Metro terminal and — when a log server is configured in the dev
 * screen — lands in ~/.happy/app-logs/*.log via happy-app-logs.
 */
import * as React from 'react';

const marks = new Map<string, number>();

function now(): number {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

/** Records a named point in time, e.g. when a session screen starts mounting. */
export function perfMark(name: string): void {
    marks.set(name, now());
}

/**
 * Logs the elapsed time since a mark. The mark is kept, so successive stages
 * (list mounted, first layout, ...) all measure from the same origin.
 */
export function perfSince(name: string, label: string): void {
    const started = marks.get(name);
    if (started === undefined) return;
    console.log(`[perf] ${label} +${Math.round(now() - started)}ms since ${name}`);
}

function useCommitPerfImpl(tag: string, detail?: string, maxCommits: number = 12, resetKey?: unknown): void {
    const renderStart = now();
    const commitCountRef = React.useRef(0);
    const resetKeyRef = React.useRef(resetKey);
    if (resetKeyRef.current !== resetKey) {
        resetKeyRef.current = resetKey;
        commitCountRef.current = 0;
    }
    React.useLayoutEffect(() => {
        if (commitCountRef.current >= maxCommits) return;
        commitCountRef.current += 1;
        const ms = now() - renderStart;
        console.log(`[perf] ${tag} commit #${commitCountRef.current} ${ms.toFixed(1)}ms${detail ? ` ${detail}` : ''}`);
    });
}

function useCommitPerfNoop(_tag: string, _detail?: string, _maxCommits?: number, _resetKey?: unknown): void {
    // Intentionally empty.
}

/**
 * Logs how long each of a component's first commits blocked the JS thread:
 * from this render's start (the hook call) to its layout effect, which fires
 * after the whole subtree has rendered and committed. Only the first
 * `maxCommits` commits log, so a streaming session doesn't spam forever.
 *
 * Dev builds only — the perf-e2e harness runs against the dev client, and a
 * release build should not pay for the ref bookkeeping or the effect at all.
 * `__DEV__` is fixed for the lifetime of a bundle, so which implementation is
 * chosen never changes at runtime and the hook order stays consistent.
 */
export const useCommitPerf = __DEV__ ? useCommitPerfImpl : useCommitPerfNoop;
