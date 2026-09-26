import { describe, expect, it, vi } from 'vitest'
import { BrowserRuntimeError, type TaskId } from './contracts'
import { RuntimeClient } from './runtimeClient'

const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 })

describe('RuntimeClient', () => {
    it('posts the request with the bearer token and returns the result', async () => {
        const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ok({ taskId: 't1' }))
        const client = new RuntimeClient({ baseUrl: 'http://x/', token: () => 'tok', fetchImpl: fetchImpl as typeof fetch })
        await expect(client.getTask({ taskId: 't1' as TaskId })).resolves.toEqual({ taskId: 't1' })
        const [url, init] = fetchImpl.mock.calls[0]
        expect(url).toBe('http://x/v1/ops/getTask')
        expect((init!.headers as Record<string, string>).authorization).toBe('Bearer tok')
    })

    it('throws the server error code, retryable and mayHaveSideEffects', async () => {
        const body = { ok: false, error: { code: 'STALE_LEASE', message: 'stale', retryable: true, mayHaveSideEffects: true } }
        const client = new RuntimeClient({ baseUrl: 'http://x', token: 't', fetchImpl: (async () => new Response(JSON.stringify(body), { status: 409 })) as typeof fetch })
        const err = await client.cancel({ taskId: 't' as TaskId, requestId: 'r' as never }).catch((e) => e)
        expect(err).toBeInstanceOf(BrowserRuntimeError)
        expect(err).toMatchObject({ code: 'STALE_LEASE', retryable: true, mayHaveSideEffects: true })
    })

    it('retries read operations on connection errors', async () => {
        let n = 0
        const fetchImpl = vi.fn(async () => { if (n++ < 2) throw new TypeError('fetch failed'); return ok({ taskId: 't1' }) })
        const client = new RuntimeClient({ baseUrl: 'http://x', token: 't', fetchImpl: fetchImpl as typeof fetch, retryDelayMs: 1 })
        await expect(client.getTask({ taskId: 't1' as TaskId })).resolves.toEqual({ taskId: 't1' })
        expect(fetchImpl).toHaveBeenCalledTimes(3)
    })

    it('never auto-retries mutations and reports possible side effects', async () => {
        const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed') })
        const client = new RuntimeClient({ baseUrl: 'http://x', token: 't', fetchImpl: fetchImpl as typeof fetch, retryDelayMs: 1 })
        const err = await client.submitBatch({ taskId: 't' as TaskId, expectedVersion: 1, requestId: 'r' as never, steps: [] }, { waitMs: 5 }).catch((e) => e)
        expect(fetchImpl).toHaveBeenCalledTimes(1)
        expect(err).toMatchObject({ code: 'RUNTIME_UNAVAILABLE', mayHaveSideEffects: true })
    })

    it('sends submitBatch waitMs in the body', async () => {
        const fetchImpl = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => ok({}))
        const client = new RuntimeClient({ baseUrl: 'http://x', token: 't', fetchImpl: fetchImpl as typeof fetch })
        await client.submitBatch({ taskId: 't' as TaskId, expectedVersion: 1, requestId: 'r' as never, steps: [] }, { waitMs: 500 })
        expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string).waitMs).toBe(500)
    })
})
