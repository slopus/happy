import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Writable } from 'node:stream'

// Mock the logger before importing the module under test
vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
    }
}))

import { createNonBlockingStdout } from './nonBlockingStdout'

describe('createNonBlockingStdout', () => {
    let originalWrite: typeof process.stdout.write
    let originalWritableNeedDrain: boolean
    let originalColumns: number | undefined
    let originalRows: number | undefined
    let writtenChunks: string[]
    let mockWriteReturn: boolean

    beforeEach(() => {
        writtenChunks = []
        mockWriteReturn = true

        // Save originals
        originalWrite = process.stdout.write
        originalWritableNeedDrain = process.stdout.writableNeedDrain
        originalColumns = process.stdout.columns
        originalRows = process.stdout.rows

        // Mock process.stdout.write
        process.stdout.write = vi.fn((...args: any[]) => {
            const chunk = args[0]
            writtenChunks.push(typeof chunk === 'string' ? chunk : chunk.toString())
            return mockWriteReturn
        }) as any

        // Make writableNeedDrain configurable
        Object.defineProperty(process.stdout, 'writableNeedDrain', {
            value: false,
            writable: true,
            configurable: true,
        })

        // Mock columns and rows (not available in test env without a real TTY)
        Object.defineProperty(process.stdout, 'columns', {
            value: 120,
            writable: true,
            configurable: true,
        })
        Object.defineProperty(process.stdout, 'rows', {
            value: 40,
            writable: true,
            configurable: true,
        })
    })

    afterEach(() => {
        process.stdout.write = originalWrite
        Object.defineProperty(process.stdout, 'writableNeedDrain', {
            value: originalWritableNeedDrain,
            configurable: true,
        })
        Object.defineProperty(process.stdout, 'columns', {
            value: originalColumns,
            configurable: true,
        })
        Object.defineProperty(process.stdout, 'rows', {
            value: originalRows,
            configurable: true,
        })
    })

    it('should forward writes when no backpressure', () => {
        const stream = createNonBlockingStdout()
        stream.write('hello')

        expect(writtenChunks).toEqual(['hello'])
    })

    it('should drop writes when writableNeedDrain is true', () => {
        const stream = createNonBlockingStdout()

        // Simulate backpressure
        Object.defineProperty(process.stdout, 'writableNeedDrain', {
            value: true,
            writable: true,
            configurable: true,
        })

        const result = stream.write('should be dropped')

        expect(writtenChunks).toEqual([])
        expect(result).toBe(true) // Returns true so Ink doesn't queue
    })

    it('should call callback even when dropping writes', () => {
        const stream = createNonBlockingStdout()
        const cb = vi.fn()

        Object.defineProperty(process.stdout, 'writableNeedDrain', {
            value: true,
            writable: true,
            configurable: true,
        })

        stream.write('dropped', cb)

        expect(cb).toHaveBeenCalled()
        expect(writtenChunks).toEqual([])
    })

    it('should proxy columns from process.stdout', () => {
        const stream = createNonBlockingStdout()

        expect(stream.columns).toBe(120)
    })

    it('should proxy rows from process.stdout', () => {
        const stream = createNonBlockingStdout()

        expect(stream.rows).toBe(40)
    })

    it('should proxy isTTY from process.stdout', () => {
        const stream = createNonBlockingStdout()

        expect(stream.isTTY).toBe(process.stdout.isTTY)
    })

    it('should resume writes after backpressure clears', () => {
        const stream = createNonBlockingStdout()

        // Write normally
        stream.write('first')
        expect(writtenChunks).toEqual(['first'])

        // Enter backpressure
        Object.defineProperty(process.stdout, 'writableNeedDrain', {
            value: true,
            writable: true,
            configurable: true,
        })

        stream.write('dropped')
        expect(writtenChunks).toEqual(['first'])

        // Clear backpressure
        Object.defineProperty(process.stdout, 'writableNeedDrain', {
            value: false,
            writable: true,
            configurable: true,
        })

        stream.write('resumed')
        expect(writtenChunks).toEqual(['first', 'resumed'])
    })

    it('should handle write with encoding parameter', () => {
        const stream = createNonBlockingStdout()
        stream.write('hello', 'utf8')

        expect(writtenChunks).toEqual(['hello'])
    })

    it('should drop multiple writes during backpressure', () => {
        const stream = createNonBlockingStdout()

        Object.defineProperty(process.stdout, 'writableNeedDrain', {
            value: true,
            writable: true,
            configurable: true,
        })

        stream.write('a')
        stream.write('b')
        stream.write('c')

        expect(writtenChunks).toEqual([])
    })

    it('should enter dropping mode when write returns false and resume on drain', () => {
        const stream = createNonBlockingStdout()
        mockWriteReturn = false

        stream.write('first')
        expect(writtenChunks).toEqual(['first'])

        // Simulate drain event — should reset dropping state
        process.stdout.emit('drain')

        mockWriteReturn = true
        stream.write('after-drain')
        expect(writtenChunks).toEqual(['first', 'after-drain'])
    })

    it('should not accumulate drain listeners on repeated write-returns-false', () => {
        const stream = createNonBlockingStdout()
        const onceSpy = vi.spyOn(process.stdout, 'once')
        mockWriteReturn = false

        stream.write('a')
        stream.write('b')
        stream.write('c')

        const drainCalls = onceSpy.mock.calls.filter(([event]) => event === 'drain')
        expect(drainCalls).toHaveLength(1)

        onceSpy.mockRestore()
    })

    it('should handle callback as second argument on normal path', () => {
        const stream = createNonBlockingStdout()
        const cb = vi.fn()

        stream.write('hello', cb)

        expect(writtenChunks).toEqual(['hello'])
        expect(process.stdout.write).toHaveBeenCalledWith('hello', cb)
    })
})
