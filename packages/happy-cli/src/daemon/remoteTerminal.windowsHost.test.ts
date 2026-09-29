import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pty = vi.hoisted(() => ({
    calls: [] as { file: string; args: string[] }[],
    kill: vi.fn(),
    exit: null as ((e: { exitCode: number; signal?: number }) => void) | null,
}))
vi.mock('node-pty', () => ({
    spawn: (file: string, args: string[]) => {
        pty.calls.push({ file, args })
        return {
            pid: 4242,
            onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => { pty.exit = cb; return { dispose() {} } },
            onData: () => ({ dispose() {} }),
            kill: pty.kill,
            write() {},
            resize() {},
        }
    },
}))

import { configureWindowsTerminalHost, createPtySession } from './remoteTerminal'

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
let receiptDirectory: string
beforeEach(() => {
    pty.calls.length = 0
    pty.kill.mockReset()
    pty.exit = null
    receiptDirectory = mkdtempSync(join(tmpdir(), 'terminal-receipts-'))
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    vi.stubEnv('SHELL', '')
})
afterEach(() => {
    configureWindowsTerminalHost(null)
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(receiptDirectory, { recursive: true, force: true })
})

const receipt = (id: string, fields: Record<string, unknown>) => writeFileSync(join(receiptDirectory, `${id}.json`),
    JSON.stringify({ version: 1, type: 'terminal-final', terminalId: id, launched: true, rootPid: 1, rootExit: 0,
        jobEmpty: true, closeRequested: true, terminated: true, nativeError: 0, ...fields }) + '\n')

describe('remote terminal under the Windows pty host (Desktop W0-5h)', () => {
    it('runs the shell under the verified launcher, which owns the terminal Job', () => {
        configureWindowsTerminalHost({ launcher: 'C:\\happy\\launcher.exe', receiptDirectory, acceptingTerminals: () => true })
        const session = createPtySession({ userId: 'u1' })

        expect(pty.calls).toEqual([{ file: 'C:\\happy\\launcher.exe', args: [
            '--pty-host', '--terminal-id', session.id, '--receipt', join(receiptDirectory, `${session.id}.json`), '--', POWERSHELL,
        ] }])
    })

    it('reports a closed terminal only once its receipt shows the Job empty', async () => {
        configureWindowsTerminalHost({ launcher: 'C:\\happy\\launcher.exe', receiptDirectory, acceptingTerminals: () => true })
        const session = createPtySession({ userId: 'u1' })
        pty.kill.mockImplementation(() => { receipt(session.id, {}); pty.exit?.({ exitCode: 0 }) })

        await expect(session.terminate({ graceMs: 500, killGraceMs: 100 })).resolves.toBe('killed')
        expect(pty.kill).toHaveBeenCalledTimes(1)
        expect(session.isAlive()).toBe(false)
    })

    it('treats a terminal whose Job is not proven empty as escaped', async () => {
        configureWindowsTerminalHost({ launcher: 'C:\\happy\\launcher.exe', receiptDirectory, acceptingTerminals: () => true })
        const unproven = createPtySession({ userId: 'u1' })
        pty.kill.mockImplementation(() => { receipt(unproven.id, { jobEmpty: false }); pty.exit?.({ exitCode: 125 }) })
        await expect(unproven.terminate({ graceMs: 200, killGraceMs: 100 })).resolves.toBe('escaped')

        const silent = createPtySession({ userId: 'u1' })
        pty.kill.mockImplementation(() => { pty.exit?.({ exitCode: 1 }) })
        await expect(silent.terminate({ graceMs: 200, killGraceMs: 100 })).resolves.toBe('escaped')
    })

    it('reports a shell that already ended as gone only with an empty-Job receipt', async () => {
        configureWindowsTerminalHost({ launcher: 'C:\\happy\\launcher.exe', receiptDirectory, acceptingTerminals: () => true })
        const session = createPtySession({ userId: 'u1' })
        receipt(session.id, { closeRequested: false, terminated: false })
        pty.exit?.({ exitCode: 0 })

        await expect(session.terminate({ graceMs: 200, killGraceMs: 100 })).resolves.toBe('already-gone')
        expect(pty.kill).not.toHaveBeenCalled()
    })

    it('refuses a new terminal once the runtime stopped accepting them (drain)', () => {
        configureWindowsTerminalHost({ launcher: 'C:\\happy\\launcher.exe', receiptDirectory, acceptingTerminals: () => false })
        expect(() => createPtySession({ userId: 'u1' })).toThrow(/closed/)
        expect(pty.calls).toEqual([])
    })

    it('keeps spawning the shell directly when no host is configured', () => {
        createPtySession({ userId: 'u1', shell: 'powershell.exe' })
        expect(pty.calls).toEqual([{ file: 'powershell.exe', args: [] }])
    })
})
