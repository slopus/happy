/**
 * PushableAsyncIterable - A generic async iterable that allows external pushing
 * Provides a clean API for creating async iterables that can be pushed to from external sources
 */

/**
 * A pushable async iterable implementation
 * Allows asynchronous pushing of values that can be consumed via for-await-of
 */
export class PushableAsyncIterable<T> implements AsyncIterableIterator<T> {
    private queue: T[] = []
    private waiters: Array<{
        resolve: (value: IteratorResult<T>) => void
        reject: (error: Error) => void
    }> = []
    private isDone = false
    private error: Error | null = null
    private started = false

    constructor() {}

    /**
     * Push a value to the iterable
     */
    push(value: T): void {
        if (this.isDone) {
            throw new Error('Cannot push to completed iterable')
        }
        
        if (this.error) {
            throw this.error
        }

        // If there's a waiting consumer, deliver directly
        const waiter = this.waiters.shift()
        if (waiter) {
            waiter.resolve({ done: false, value })
        } else {
            // Otherwise queue the value
            this.queue.push(value)
        }
    }

    /**
     * Mark the iterable as complete
     */
    end(): void {
        if (this.isDone) {
            return
        }
        
        this.isDone = true
        this.cleanup()
    }

    /**
     * Set an error on the iterable
     */
    setError(err: Error): void {
        if (this.isDone) {
            return
        }
        
        this.error = err
        this.isDone = true
        this.cleanup()
    }

    /**
     * Cleanup waiting consumers
     */
    private cleanup(): void {
        // Resolve or reject all waiting consumers
        while (this.waiters.length > 0) {
            const waiter = this.waiters.shift()!
            if (this.error) {
                waiter.reject(this.error)
            } else {
                waiter.resolve({ done: true, value: undefined })
            }
        }
    }

    /**
     * AsyncIterableIterator implementation
     */
    async next(): Promise<IteratorResult<T>> {
        // Return queued items first
        if (this.queue.length > 0) {
            return { done: false, value: this.queue.shift()! }
        }

        // Check if we're done or have an error
        if (this.isDone) {
            if (this.error) {
                throw this.error
            }
            return { done: true, value: undefined }
        }

        // Wait for next value
        return new Promise<IteratorResult<T>>((resolve, reject) => {
            this.waiters.push({ resolve, reject })
        })
    }

    /**
     * AsyncIterableIterator return implementation
     */
    async return(_value?: any): Promise<IteratorResult<T>> {
        this.end()
        return { done: true, value: undefined }
    }

    /**
     * AsyncIterableIterator throw implementation
     */
    async throw(e: any): Promise<IteratorResult<T>> {
        this.setError(e instanceof Error ? e : new Error(String(e)))
        throw this.error
    }

    /**
     * Make this iterable
     */
    [Symbol.asyncIterator](): AsyncIterableIterator<T> {
        if (this.started) {
            throw new Error('PushableAsyncIterable can only be iterated once')
        }
        this.started = true
        return this
    }

    /**
     * Check if the iterable is done
     */
    get done(): boolean {
        return this.isDone
    }

    /**
     * Check if the iterable has an error
     */
    get hasError(): boolean {
        return this.error !== null
    }

    /**
     * Get the current queue size
     */
    get queueSize(): number {
        return this.queue.length
    }

    /**
     * Get the number of waiting consumers
     */
    get waiterCount(): number {
        return this.waiters.length
    }
}