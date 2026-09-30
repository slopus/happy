import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isRoutingProtect,
  resolveDifficultyRouting,
  type DifficultyRoutingRuntimeDecision,
  type DifficultyRoutingRuntimeOutcome,
} from './difficultyRoutingRuntime'

/** A protective decline must never be read as a decision by accident. */
function asDecision(outcome: DifficultyRoutingRuntimeOutcome): DifficultyRoutingRuntimeDecision {
  if (!outcome || isRoutingProtect(outcome)) {
    throw new Error(`expected a routing decision, received ${JSON.stringify(outcome)}`)
  }
  return outcome
}
import { DifficultyRoutingClassifierHost, createDifficultyRoutingHostKey } from './daemon/difficultyRoutingClassifierHost'

const intent = { version: 1, mode: 'auto', policy: 'org-shared-difficulty-routing.v1', clientRequestId: 'turn-flow', clientRouteSource: 'default-auto' }
const text = 'Add a save button to the draft form'
const input = { agent: 'codex' as const, sourceMachineId: 'source', sessionId: 'session', contentText: 'SYSTEM WRAPPER: ' + text,
  meta: { difficultyRoutingIntent: intent, difficultyRoutingAuthorization: 'turn-authority', difficultyRoutingPrompt: text, modelSource: 'auto', model: 'fallback-model' }, current: { model: 'fallback-model' } }
let host: DifficultyRoutingClassifierHost | undefined
afterEach(() => { host?.terminate(); host = undefined; vi.unstubAllGlobals(); vi.useRealTimers() })

function setup(options: { revoke?: boolean; wrongResponse?: boolean; serverSkewMs?: number; workerDelayMs?: number } = {}) {
  const key = createDifficultyRoutingHostKey()
  const received: Record<string, unknown>[] = []
  const worker = new EventEmitter() as EventEmitter & { send: (message: Record<string, unknown>) => void; kill: () => void }
  worker.kill = () => { worker.emit('exit', 0) }
  worker.send = message => {
    if (message.type === 'prepare') queueMicrotask(() => worker.emit('message', { type: 'ready', classifierRevision: 'fixed-artifact' }))
    else {
      received.push(message)
      const reply = () => worker.emit('message', { type: 'result', requestId: message.requestId, difficulty: 'hard', classifierRevision: 'fixed-artifact' })
      if (options.workerDelayMs) setTimeout(reply, options.workerDelayMs)
      else queueMicrotask(reply)
    }
  }
  const authorize = vi.fn(async () => !options.revoke)
  host = new DifficultyRoutingClassifierHost(key, { spawnWorker: () => worker as never, authorize })
  host.setEnabled(true)
  const requests: { path: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname, body = JSON.parse(String(init.body))
    requests.push({ path, body })
    expect(String(init.body)).not.toContain(text)
    expect(String(init.body)).not.toContain('SYSTEM WRAPPER')
    if (path.endsWith('/grant')) {
      expect(body).toMatchObject({ authorization: 'turn-authority', sourceMachineId: 'source', sessionId: 'session', clientRequestId: 'turn-flow' })
      expect(body.timingVersion).toBe(2)
      // Issued entirely on the server's clock, which may sit anywhere relative to ours.
      const issuedAt = Date.now() + (options.serverSkewMs ?? 0)
      return Response.json({ ok: true, aiModelPolicy: { source: 'unrestricted', allowedSelectionKeys: null, defaultSelectionKey: null }, signedGrant: 'validated-grant', grant: { version: 1, grantId: 'grant-flow', policyRevision: 4, issuedAt, expiresAt: issuedAt + 10000, ttlMs: 10000, relayTtlMs: 3000, timingVersion: 2, requestId: 'turn-flow', sourceMachineId: 'source', hostMachineId: 'host', hostProcessKeyId: key.id, hostProcessPublicKey: Buffer.from(key.publicKey).toString('base64'), maxInputChars: 8000, modelMaxInputTokens: 512, relayDeadlineAt: issuedAt + 3000 } })
    }
    expect(path.endsWith('/classify')).toBe(true)
    // The client must hand the host a duration, never an instant from another machine.
    expect(body.timingVersion).toBe(2)
    expect(body.deadlineAt).toBeUndefined()
    expect(body.remainingMs).toBeGreaterThan(0)
    expect(body.remainingMs).toBeLessThanOrEqual(3000)
    const result = await host!.classify(body)
    return Response.json({ ok: true, result: options.wrongResponse ? { ...result, requestId: 'other-turn' } : result })
  }))
  return { received, authorize, requests }
}

describe('sealed shared classifier flow', () => {
  it('keeps a 2.2 second classifier round trip remote within the shared 3 second budget', async () => {
    vi.useFakeTimers()
    setup({ workerDelayMs: 2200 })
    await vi.advanceTimersByTimeAsync(0)
    const pending = resolveDifficultyRouting(input)
    await vi.advanceTimersByTimeAsync(2200)
    expect(asDecision(await pending).event.ev).toMatchObject({ result: { classifierSource: 'p2-org-shared' } })
  })
  it('sends only original text to the native worker and returns its actual model decision', async () => {
    const f = setup()
    const result = await resolveDifficultyRouting(input)
    expect(f.requests).toHaveLength(2)
    expect(f.authorize).toHaveBeenCalledTimes(2)
    expect(f.received).toEqual([{ type: 'classify', requestId: 'turn-flow', text, maxInputTokens: 512 }])
    expect(asDecision(result).route).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high', difficulty: 'hard' })
    expect(asDecision(result).event.ev).toMatchObject({ t: 'difficulty-routing', result: { model: 'gpt-6.1-sol', classifierSource: 'p2-org-shared', policyRevision: 4 } })
  })
  it('does not decrypt after revocation and falls back to local P1', async () => {
    const f = setup({ revoke: true })
    const result = await resolveDifficultyRouting(input)
    expect(f.received).toEqual([])
    expect(asDecision(result).route.difficulty).toBe('routine')
    expect(asDecision(result).event.ev).toMatchObject({ result: { classifierSource: 'fallback-p1' } })
  })
  it('discards a response bound to another turn', async () => {
    setup({ wrongResponse: true })
    const result = await resolveDifficultyRouting(input)
    expect(asDecision(result).route.difficulty).toBe('routine')
    expect(asDecision(result).event.ev).toMatchObject({ result: { classifierSource: 'fallback-p1' } })
  })
  // The end-to-end point of timing v2: the three clocks are independent and the turn still
  // completes. Under v1 a server this far ahead was rejected outright at grant validation.
  it('completes the whole round trip however far the clocks sit apart', async () => {
    for (const serverSkewMs of [2, -2, 2_000, -2_000, 86_400_000, -86_400_000]) {
      const f = setup({ serverSkewMs })
      const result = await resolveDifficultyRouting(input)
      expect(f.received, `skew ${serverSkewMs}`).toEqual([{ type: 'classify', requestId: 'turn-flow', text, maxInputTokens: 512 }])
      expect(asDecision(result).event.ev, `skew ${serverSkewMs}`).toMatchObject({ result: { classifierSource: 'p2-org-shared' } })
      host?.terminate(); host = undefined
    }
  })

  it('preserves manual choices without any classification request', async () => {
    const f = setup()
    expect(await resolveDifficultyRouting({ ...input, meta: { ...input.meta, modelSource: 'user' } })).toBeNull()
    expect(f.requests).toEqual([])
  })
})
