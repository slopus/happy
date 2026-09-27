import { describe, expect, it } from 'vitest';

import {
    decideAutomationResumePreflight,
    hasLiveDaemonChild,
    resolveAutomationDirectoryMatch,
    shareInFlight,
} from './resumeGuards';

// 2026-08-05 incident: two resume-happy-session RPCs 6.7s apart spawned two CLI
// processes for the same happy session. Both attached, both idle, both were
// empty-reaped 15 minutes later. A resume must reuse a live child and share an
// in-flight spawn instead of double-spawning.
describe('hasLiveDaemonChild', () => {
    const alive = () => true;

    it('detects a live child already attached to the session', () => {
        expect(hasLiveDaemonChild('session-1', [
            { happySessionId: 'session-other', pid: 10 },
            { happySessionId: 'session-1', pid: 11 },
        ], alive)).toBe(true);
    });

    it('reports no live child when only other sessions are running', () => {
        expect(hasLiveDaemonChild('session-1', [
            { happySessionId: 'session-other', pid: 10 },
            { happySessionId: undefined, pid: 11 },
        ], alive)).toBe(false);
    });

    // Adopted/external sessions have no childProcess handle, so no exit event
    // removes them — only the periodic health check prunes dead PIDs. Trusting
    // the map alone would answer "already running" for a session whose process
    // died seconds ago, and the resume would spawn nothing at all.
    it('ignores a tracked entry whose process is already dead', () => {
        expect(hasLiveDaemonChild('session-1', [
            { happySessionId: 'session-1', pid: 99 },
        ], (pid) => pid !== 99)).toBe(false);
    });

    it('still finds a live entry when a dead duplicate is listed first', () => {
        expect(hasLiveDaemonChild('session-1', [
            { happySessionId: 'session-1', pid: 99 },
            { happySessionId: 'session-1', pid: 100 },
        ], (pid) => pid !== 99)).toBe(true);
    });
});

// 2026-09-11 incident: resume RPC #1 spawned PID 2380763 at 08:16:44. Its
// session webhook never arrived, so at 08:17:55 the 60s timeout failed the RPC
// — releasing the in-flight slot — while leaving the process running and
// attached to the session. The tracked entry still had no happySessionId
// (only the webhook sets it), so the liveness guard below answered "no live
// child" and resume RPC #2 at 08:18:33 spawned a second CLI. Both stayed
// attached for over an hour: the Claude transcript forked in two, every user
// message was written to both branches, and both processes' session scanners
// re-uploaded them — the user saw each message as three bubbles.
//
// A daemon child claims its resume target at spawn time, so the guard must see
// the claim during the whole window before the webhook lands.
describe('hasLiveDaemonChild — resume target claimed before the webhook lands', () => {
    const alive = () => true;

    it('detects a resume child that has not reported its session webhook yet', () => {
        expect(hasLiveDaemonChild('session-1', [
            { resumeTargetSessionId: 'session-1', pid: 11 },
        ], alive)).toBe(true);
    });

    it('does not match a resume claim for a different session', () => {
        expect(hasLiveDaemonChild('session-1', [
            { resumeTargetSessionId: 'session-other', pid: 11 },
        ], alive)).toBe(false);
    });

    // The claim is not a liveness certificate: a spawn that died before its
    // webhook must not make the retry a no-op, which would leave the session
    // with no process at all.
    it('ignores a resume claim whose process is already dead', () => {
        expect(hasLiveDaemonChild('session-1', [
            { resumeTargetSessionId: 'session-1', pid: 99 },
        ], (pid) => pid !== 99)).toBe(false);
    });

    it('still finds a live webhook-confirmed child past a dead resume claim', () => {
        expect(hasLiveDaemonChild('session-1', [
            { resumeTargetSessionId: 'session-1', pid: 99 },
            { happySessionId: 'session-1', pid: 100 },
        ], (pid) => pid !== 99)).toBe(true);
    });
});

describe('decideAutomationResumePreflight', () => {
    it('falls back immediately when a live target belongs to another directory', () => {
        expect(decideAutomationResumePreflight({
            resumeInFlight: false,
            live: true,
            sameDirectory: false,
        })).toBe('fallback');
    });

    it('keeps a same-directory or unresolved live target busy to protect the writer', () => {
        expect(decideAutomationResumePreflight({
            resumeInFlight: false,
            live: true,
            sameDirectory: true,
        })).toBe('busy');
        expect(decideAutomationResumePreflight({
            resumeInFlight: false,
            live: true,
            sameDirectory: null,
        })).toBe('busy');
    });

    it('keeps an in-flight resume busy and otherwise proceeds', () => {
        expect(decideAutomationResumePreflight({
            resumeInFlight: true,
            live: false,
            sameDirectory: false,
        })).toBe('busy');
        expect(decideAutomationResumePreflight({
            resumeInFlight: false,
            live: false,
            sameDirectory: false,
        })).toBe('resume');
    });
});

describe('resolveAutomationDirectoryMatch', () => {
    it('recognizes symlink and canonical paths that resolve to the same directory', async () => {
        const realpath = async (path: string) => path === '/repo-link' ? '/actual/repo' : path;

        await expect(resolveAutomationDirectoryMatch(
            '/repo-link',
            '/actual/repo',
            realpath,
        )).resolves.toBe(true);
    });

    it('returns unknown when either directory cannot be resolved safely', async () => {
        await expect(resolveAutomationDirectoryMatch(
            '/missing',
            '/repo',
            async () => { throw new Error('missing'); },
        )).resolves.toBeNull();
    });
});

describe('shareInFlight', () => {
    it('returns the same promise for concurrent calls with the same key', async () => {
        const inflight = new Map<string, Promise<string>>();
        let spawns = 0;
        let release!: (value: string) => void;
        const factory = () => {
            spawns += 1;
            return new Promise<string>((resolve) => { release = resolve; });
        };

        const first = shareInFlight(inflight, 'session-1', factory);
        const second = shareInFlight(inflight, 'session-1', factory);
        release('spawned');

        expect(await first).toBe('spawned');
        expect(await second).toBe('spawned');
        expect(spawns).toBe(1);
    });

    it('runs the factory again once the previous call settled', async () => {
        const inflight = new Map<string, Promise<string>>();
        let spawns = 0;
        const factory = async () => {
            spawns += 1;
            return `spawn-${spawns}`;
        };

        expect(await shareInFlight(inflight, 'session-1', factory)).toBe('spawn-1');
        expect(await shareInFlight(inflight, 'session-1', factory)).toBe('spawn-2');
        expect(inflight.size).toBe(0);
    });

    it('clears the in-flight slot when the factory rejects', async () => {
        const inflight = new Map<string, Promise<string>>();
        await expect(shareInFlight(inflight, 'session-1', async () => {
            throw new Error('spawn failed');
        })).rejects.toThrow('spawn failed');

        expect(inflight.size).toBe(0);
        expect(await shareInFlight(inflight, 'session-1', async () => 'recovered')).toBe('recovered');
    });

    it('keeps different keys independent', async () => {
        const inflight = new Map<string, Promise<string>>();
        const [a, b] = await Promise.all([
            shareInFlight(inflight, 'session-a', async () => 'a'),
            shareInFlight(inflight, 'session-b', async () => 'b'),
        ]);
        expect(a).toBe('a');
        expect(b).toBe('b');
    });
});

it('blocks a duplicate resume while the owned Job remains unresolved after root PID exit', () => {
    const sessions = [{ happySessionId: 'session-1', pid: 99 }];
    expect(hasLiveDaemonChild('session-1', sessions, () => false, pid => pid === 99)).toBe(true);
    expect(hasLiveDaemonChild('session-1', sessions, () => false, () => false)).toBe(false);
});
