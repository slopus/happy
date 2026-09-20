import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { spawn } from 'child_process'
import type { createInterface } from 'readline'
import { MacCapabilityMonitor } from './macCapability'

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
    },
}))

class FakeChild extends EventEmitter {
    stdout: PassThrough | null = new PassThrough()
    killed = false
    kill = vi.fn(() => {
        this.killed = true
        return true
    })
}

class FakeOutput extends EventEmitter {
    close = vi.fn()
}

function makeMonitor(child: FakeChild, output: FakeOutput, spawnProcess = vi.fn(() => child)) {
    const createLineReader = vi.fn(() => output)
    const monitor = new MacCapabilityMonitor({
        platform: 'darwin',
        helperPath: '/tmp/happy-capability',
        exists: vi.fn(() => true),
        spawn: spawnProcess as unknown as typeof spawn,
        createInterface: createLineReader as unknown as typeof createInterface,
    })
    return { monitor, createLineReader, spawnProcess }
}

afterEach(() => {
    vi.useRealTimers()
})

describe('MacCapabilityMonitor', () => {
    it('starts once for multiple clients and tracks full/dark wake transitions', () => {
        const child = new FakeChild()
        const output = new FakeOutput()
        const { monitor, spawnProcess } = makeMonitor(child, output)

        monitor.acquire()
        monitor.acquire()
        expect(monitor.getState()).toEqual({ status: 'pending', fullWake: null })
        expect(spawnProcess).toHaveBeenCalledOnce()

        output.emit('line', '{"event":"capability-change","phase":"initial","to":15}')
        expect(monitor.getState()).toEqual({ status: 'ready', fullWake: true })

        output.emit('line', '{"event":"capability-change","phase":"will-change","to":9}')
        expect(monitor.getState()).toEqual({ status: 'ready', fullWake: false })

        output.emit('line', '{"event":"capability-change","phase":"will-change","to":15}')
        expect(monitor.getState()).toEqual({ status: 'ready', fullWake: false })

        output.emit('line', '{"event":"capability-change","phase":"did-change","to":15}')
        expect(monitor.getState()).toEqual({ status: 'ready', fullWake: true })

        monitor.release()
        expect(child.kill).not.toHaveBeenCalled()
        monitor.release()
        expect(child.kill).toHaveBeenCalledWith('SIGTERM')
        expect(output.close).toHaveBeenCalledOnce()
        expect(monitor.getState()).toEqual({ status: 'unavailable', fullWake: null })
        expect(spawnProcess).toHaveBeenCalledOnce()
    })

    it('fails closed while pending and falls back to unavailable after startup timeout', () => {
        vi.useFakeTimers()
        const child = new FakeChild()
        const output = new FakeOutput()
        const { monitor } = makeMonitor(child, output)

        monitor.acquire()
        expect(monitor.getState()).toEqual({ status: 'pending', fullWake: null })

        vi.advanceTimersByTime(5000)
        expect(monitor.getState()).toEqual({ status: 'unavailable', fullWake: null })
        expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    })

    it('handles malformed output without accepting it as a capability snapshot', () => {
        const child = new FakeChild()
        const output = new FakeOutput()
        const { monitor } = makeMonitor(child, output)

        monitor.acquire()
        output.emit('line', 'not-json')
        output.emit('line', 'null')
        output.emit('line', '[]')
        output.emit('line', '"capability-change"')
        output.emit('line', '{"event":"other","to":15}')
        output.emit('line', '{"event":"capability-change","to":"15"}')
        output.emit('line', '{"event":"capability-change","phase":"did-change","to":4294967296}')

        expect(monitor.getState()).toEqual({ status: 'pending', fullWake: null })
        monitor.stop()
    })

    it('handles helper errors and exits as unavailable', () => {
        const child = new FakeChild()
        const output = new FakeOutput()
        const { monitor } = makeMonitor(child, output)

        monitor.acquire()
        child.emit('error', new Error('helper failed'))
        expect(monitor.getState()).toEqual({ status: 'unavailable', fullWake: null })
        expect(output.close).toHaveBeenCalledOnce()

        monitor.stop()

        const exitedChild = new FakeChild()
        const exitedOutput = new FakeOutput()
        const exited = makeMonitor(exitedChild, exitedOutput)
        exited.monitor.acquire()
        exitedChild.emit('exit', 1, 'SIGTERM')
        expect(exited.monitor.getState()).toEqual({ status: 'unavailable', fullWake: null })
        expect(exitedOutput.close).toHaveBeenCalledOnce()
    })

    it('handles a helper without stdout and spawn failures', () => {
        const missing = new MacCapabilityMonitor({
            platform: 'darwin',
            helperPath: '/tmp/missing-happy-capability',
            exists: vi.fn(() => false),
            spawn: vi.fn() as unknown as typeof spawn,
        })
        missing.acquire()
        expect(missing.getState()).toEqual({ status: 'unavailable', fullWake: null })

        const noOutputChild = new FakeChild()
        noOutputChild.stdout = null
        const noOutput = makeMonitor(noOutputChild, new FakeOutput())
        noOutput.monitor.acquire()
        expect(noOutput.monitor.getState()).toEqual({ status: 'unavailable', fullWake: null })
        expect(noOutputChild.kill).toHaveBeenCalledWith('SIGTERM')

        const spawnFailure = makeMonitor(
            new FakeChild(),
            new FakeOutput(),
            vi.fn(() => {
                throw new Error('cannot spawn')
            }),
        )
        spawnFailure.monitor.acquire()
        expect(spawnFailure.monitor.getState()).toEqual({ status: 'unavailable', fullWake: null })
    })

    it('does not start on unsupported platforms', () => {
        const spawnProcess = vi.fn()
        const monitor = new MacCapabilityMonitor({
            platform: 'linux',
            spawn: spawnProcess as unknown as typeof spawn,
        })

        monitor.acquire()
        expect(monitor.getState()).toEqual({ status: 'unsupported', fullWake: null })
        expect(spawnProcess).not.toHaveBeenCalled()
        monitor.release()
    })
})