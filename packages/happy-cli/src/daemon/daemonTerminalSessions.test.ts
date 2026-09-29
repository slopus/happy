import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setTimeout as sleep } from 'node:timers/promises'
import {
    addDaemonTerminalSession,
    getDaemonTerminalSession,
    getDaemonTerminalSessionCount,
    removeDaemonTerminalSession,
    killAllDaemonTerminalSessions,
    terminateAllDaemonTerminalSessions,
    recordBytesIn,
    recordBytesOut,
    _resetDaemonTerminalSessionsForTest,
} from './daemonTerminalSessions'
import { createPtySession, type PtySession } from './remoteTerminal'

describe('daemonTerminalSessions', () => {
    const tracked: PtySession[] = []

    beforeEach(() => {
        _resetDaemonTerminalSessionsForTest()
    })
    afterEach(() => {
        while (tracked.length) {
            try { tracked.pop()?.kill('SIGKILL') } catch {/* gone */ }
        }
    })

    function spawn(): PtySession {
        const s = createPtySession({
            userId: 'u1',
            shell: 'node',
            args: ['-e', 'setInterval(() => {}, 1000)'],
        })
        tracked.push(s)
        return s
    }

    it('add() returns an entry with userId, machineId, openedAt, zero counters', () => {
        const before = Date.now()
        const pty = spawn()
        const entry = addDaemonTerminalSession('abc', pty, {
            userId: 'alice',
            machineId: 'm1',
            idleTimeoutMs: 0,
        })
        expect(entry.id).toBe('abc')
        expect(entry.userId).toBe('alice')
        expect(entry.machineId).toBe('m1')
        expect(entry.session).toBe(pty)
        expect(entry.bytesIn).toBe(0)
        expect(entry.bytesOut).toBe(0)
        expect(entry.openedAt).toBeGreaterThanOrEqual(before)
    })

    it('get() round-trips by id and returns null for missing', () => {
        const pty = spawn()
        addDaemonTerminalSession('abc', pty, { userId: 'u', idleTimeoutMs: 0 })
        expect(getDaemonTerminalSession('abc')?.session.id).toBe(pty.id)
        expect(getDaemonTerminalSession('nope')).toBeNull()
        expect(getDaemonTerminalSession(undefined)).toBeNull()
        expect(getDaemonTerminalSession('')).toBeNull()
    })

    it('reports the active terminal count for daemon activity checks', () => {
        const pty = spawn()
        expect(getDaemonTerminalSessionCount()).toBe(0)
        addDaemonTerminalSession('abc', pty, { userId: 'u', idleTimeoutMs: 0 })
        expect(getDaemonTerminalSessionCount()).toBe(1)
        removeDaemonTerminalSession('abc')
        expect(getDaemonTerminalSessionCount()).toBe(0)
    })

    it('remove() reports whether the entry existed and clears it', () => {
        const pty = spawn()
        addDaemonTerminalSession('a', pty, { userId: 'u', idleTimeoutMs: 0 })
        expect(removeDaemonTerminalSession('a')).toBe(true)
        expect(removeDaemonTerminalSession('a')).toBe(false)
        expect(getDaemonTerminalSession('a')).toBeNull()
    })

    it('recordBytesIn/Out accumulate counters and update lastActivityAt', () => {
        const pty = spawn()
        const entry = addDaemonTerminalSession('a', pty, { userId: 'u', idleTimeoutMs: 0 })
        const initialActivity = entry.lastActivityAt
        // Force a measurable wallclock gap before activity (Date.now resolves
        // to ms; sleep 5ms is enough on every platform we care about).
        return sleep(5).then(() => {
            recordBytesIn('a', 10)
            recordBytesIn('a', 5)
            recordBytesOut('a', 8)
            expect(entry.bytesIn).toBe(15)
            expect(entry.bytesOut).toBe(8)
            expect(entry.lastActivityAt).toBeGreaterThan(initialActivity)
        })
    })

    it('record* on missing or non-positive ignored', () => {
        const pty = spawn()
        const entry = addDaemonTerminalSession('a', pty, { userId: 'u', idleTimeoutMs: 0 })
        recordBytesIn('nope', 100)
        recordBytesIn('a', 0)
        recordBytesIn('a', -3)
        recordBytesOut('a', 0)
        expect(entry.bytesIn).toBe(0)
        expect(entry.bytesOut).toBe(0)
    })

    it('idle timeout sends SIGHUP to the PTY after the configured ms', async () => {
        const pty = spawn()
        addDaemonTerminalSession('a', pty, { userId: 'u', idleTimeoutMs: 200 })
        const exited = new Promise<{ code: number; signal: number | null }>((res) => {
            pty.onExit((code, signal) => res({ code, signal }))
        })
        const exitInfo = await Promise.race([
            exited,
            sleep(2000).then(() => { throw new Error('PTY did not exit on idle within 2s') }),
        ])
        // SIGHUP terminates the process; code is non-zero or signal set —
        // exact value is platform-specific, just confirm something happened.
        expect(exitInfo).toBeDefined()
    })

    it('activity resets the idle timer (no kill while bytes flow)', async () => {
        const pty = spawn()
        addDaemonTerminalSession('a', pty, { userId: 'u', idleTimeoutMs: 200 })
        let exited = false
        pty.onExit(() => { exited = true })

        // Tickle activity every 100ms for 600ms — well past the 200ms idle.
        // PTY must NOT have been killed.
        const stopAt = Date.now() + 600
        while (Date.now() < stopAt) {
            recordBytesIn('a', 1)
            await sleep(100)
        }
        expect(exited).toBe(false)

        // Now stop tickling; should die after ~200ms.
        await sleep(400)
        expect(exited).toBe(true)
    })

    it('removeDaemonTerminalSession cancels the idle timer', async () => {
        const pty = spawn()
        addDaemonTerminalSession('a', pty, { userId: 'u', idleTimeoutMs: 150 })
        let exited = false
        pty.onExit(() => { exited = true })

        // Remove from map immediately; idle timer should be cancelled and
        // the PTY should NOT be killed by it.
        expect(removeDaemonTerminalSession('a')).toBe(true)

        await sleep(400) // 2.5x the idle window
        expect(exited).toBe(false)
    })

    it('killAll signals every session, clears timers, and empties the map', async () => {
        const a = spawn()
        const b = spawn()
        addDaemonTerminalSession('a', a, { userId: 'u', idleTimeoutMs: 0 })
        addDaemonTerminalSession('b', b, { userId: 'u', idleTimeoutMs: 0 })

        const exitsP = Promise.all([
            new Promise<void>((res) => a.onExit(() => res())),
            new Promise<void>((res) => b.onExit(() => res())),
        ])

        const killed = killAllDaemonTerminalSessions()
        expect(killed).toBe(2)
        expect(getDaemonTerminalSession('a')).toBeNull()
        expect(getDaemonTerminalSession('b')).toBeNull()

        await Promise.race([
            exitsP,
            sleep(3000).then(() => { throw new Error('PTYs did not exit within 3s of killAll') }),
        ])
    })

    /**
     * specs/remote-terminal-close-leak/ — the `node -e` fixture above dies on
     * any signal, so it can never catch the bug that actually shipped: an
     * interactive shell ignores SIGTERM and every teardown path here used to
     * send exactly that. These cases use a real `/bin/bash -l`.
     */
    describe.skipIf(process.platform === 'win32')('interactive shell teardown', () => {
        const shells: PtySession[] = []

        afterEach(() => {
            while (shells.length) {
                try { shells.pop()?.kill('SIGKILL') } catch {/* gone */ }
            }
        })

        function spawnLoginShell(): PtySession {
            const s = createPtySession({ userId: 'u1', shell: '/bin/bash', args: ['-l'] })
            shells.push(s)
            return s
        }

        async function waitUntilDead(s: PtySession, ms: number): Promise<void> {
            const end = Date.now() + ms
            while (Date.now() < end && s.isAlive()) await sleep(25)
        }

        it('killAll actually reaps interactive login shells', async () => {
            const a = spawnLoginShell()
            const b = spawnLoginShell()
            addDaemonTerminalSession('a', a, { userId: 'u', idleTimeoutMs: 0 })
            addDaemonTerminalSession('b', b, { userId: 'u', idleTimeoutMs: 0 })
            await sleep(300) // let bash install its signal dispositions

            expect(killAllDaemonTerminalSessions()).toBe(2)

            await waitUntilDead(a, 1800)
            await waitUntilDead(b, 1800)
            expect(a.isAlive()).toBe(false)
            expect(b.isAlive()).toBe(false)
        })

        it('idle timeout actually reaps an interactive login shell', async () => {
            const s = spawnLoginShell()
            addDaemonTerminalSession('a', s, { userId: 'u', idleTimeoutMs: 300 })
            await sleep(300)

            await waitUntilDead(s, 2500)
            expect(s.isAlive()).toBe(false)
        })
    })

    // Desktop specs/windows-build-support W0-5h: an app-close drain must know every terminal is gone.
    it('terminates every session and reports each outcome, leaving the registry empty', async () => {
        const outcomes = ['killed', 'escaped'] as const
        let n = 0
        const fake = (): PtySession => {
            const outcome = outcomes[n++]
            return { id: `t${n}`, userId: 'u1', pid: 1, cols: 80, rows: 24, write() {}, resize() {}, kill() {}, isAlive: () => true,
                terminate: async () => outcome, onData: () => () => {}, onExit: () => () => {} }
        }
        addDaemonTerminalSession('t1', fake(), { userId: 'u1' })
        addDaemonTerminalSession('t2', fake(), { userId: 'u1' })

        await expect(terminateAllDaemonTerminalSessions()).resolves.toEqual(['killed', 'escaped'])
        expect(getDaemonTerminalSessionCount()).toBe(0)
    })
})
