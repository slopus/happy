/**
 * Tests for PushableAsyncIterable
 */

import { describe, it, expect } from 'vitest'
import { PushableAsyncIterable } from './PushableAsyncIterable'

describe('PushableAsyncIterable', () => {
    it('should push and consume values', async () => {
        const iterable = new PushableAsyncIterable<number>()
        const results: number[] = []

        // Start consuming
        const consumer = (async () => {
            for await (const value of iterable) {
                results.push(value)
                if (results.length === 3) {
                    break
                }
            }
        })()

        // Push values
        iterable.push(1)
        iterable.push(2)
        iterable.push(3)

        await consumer
        expect(results).toEqual([1, 2, 3])
    })

    it('should handle async pushing', async () => {
        const iterable = new PushableAsyncIterable<string>()
        const results: string[] = []

        // Start consuming
        const consumer = (async () => {
            for await (const value of iterable) {
                results.push(value)
            }
        })()

        // Push values asynchronously
        await Promise.resolve()
        iterable.push('first')
        
        await new Promise(resolve => setTimeout(resolve, 10))
        iterable.push('second')
        
        await new Promise(resolve => setTimeout(resolve, 10))
        iterable.push('third')
        iterable.end()

        await consumer
        expect(results).toEqual(['first', 'second', 'third'])
    })

    it('should handle errors', async () => {
        const iterable = new PushableAsyncIterable<number>()
        const error = new Error('Test error')

        const consumer = (async () => {
            const values: number[] = []
            try {
                for await (const value of iterable) {
                    values.push(value)
                }
            } catch (e) {
                expect(e).toBe(error)
                return values
            }
            throw new Error('Should have thrown')
        })()

        iterable.push(1)
        iterable.push(2)
        iterable.setError(error)

        const values = await consumer
        expect(values).toEqual([1, 2])
    })

    it('should handle external error control', async () => {
        const iterable = new PushableAsyncIterable<number>()
        
        const consumer = (async () => {
            const values: number[] = []
            try {
                for await (const value of iterable) {
                    values.push(value)
                    if (value === 2) {
                        // Set error externally after second value
                        iterable.setError(new Error('External abort'))
                    }
                }
            } catch (e) {
                expect((e as Error).message).toBe('External abort')
                return values
            }
            throw new Error('Should have thrown')
        })()

        iterable.push(1)
        iterable.push(2)

        const values = await consumer
        expect(values).toEqual([1, 2])
    })

    it('should queue values when no consumer is waiting', async () => {
        const iterable = new PushableAsyncIterable<number>()
        
        // Push values before consumer starts
        iterable.push(1)
        iterable.push(2)
        iterable.push(3)
        iterable.end()

        // Start consuming
        const results: number[] = []
        for await (const value of iterable) {
            results.push(value)
        }

        expect(results).toEqual([1, 2, 3])
    })

    it('should throw when pushing to completed iterable', () => {
        const iterable = new PushableAsyncIterable<number>()
        iterable.end()
        
        expect(() => iterable.push(1)).toThrow('Cannot push to completed iterable')
    })

    it('should only allow single iteration', async () => {
        const iterable = new PushableAsyncIterable<number>()
        
        // First iteration is fine
        const iterator1 = iterable[Symbol.asyncIterator]()
        
        // Second iteration should throw
        expect(() => iterable[Symbol.asyncIterator]()).toThrow('PushableAsyncIterable can only be iterated once')
    })

    it('should provide queue and waiter status', async () => {
        const iterable = new PushableAsyncIterable<number>()
        
        // Push values - they should be queued
        iterable.push(1)
        iterable.push(2)
        expect(iterable.queueSize).toBe(2)
        expect(iterable.waiterCount).toBe(0)
        
        // Start consuming
        const consumer = (async () => {
            for await (const value of iterable) {
                if (value === 2) {
                    // After consuming 2 values, queue should be empty
                    expect(iterable.queueSize).toBe(0)
                    // Next iteration will create a waiter since queue is empty
                    // We need to let the loop iterate again to create the waiter
                    setTimeout(() => {
                        expect(iterable.waiterCount).toBe(1)
                        iterable.end() // End to complete the test
                    }, 10)
                }
                if (value === 3) {
                    break // This shouldn't happen, but just in case
                }
            }
        })()
        
        await consumer
    })
})