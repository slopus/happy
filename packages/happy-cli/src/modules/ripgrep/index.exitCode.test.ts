import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'cross-spawn'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('cross-spawn', () => ({
    spawn: vi.fn(),
}))

type MockChild = EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
}

function createMockChild(): MockChild {
    const child = new EventEmitter() as MockChild
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = vi.fn()
    return child
}

describe('ripgrep truncation exit code', () => {
    beforeEach(() => {
        vi.resetModules()
        vi.mocked(spawn).mockReset()
    })

    it('forces a non-zero exit code when truncated output closes with code 0', async () => {
        const child = createMockChild()
        vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess)
        const { run } = await import('./index')

        const resultPromise = run(['--version'], { maxBufferBytes: 1 })
        child.stdout.emit('data', Buffer.from('ripgrep'))
        child.emit('close', 0)

        const result = await resultPromise
        expect(result.truncated).toBe(true)
        expect(result.exitCode).not.toBe(0)
    })
})
