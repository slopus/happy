import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeSwapSupervisor, type ClaudeSwapChild } from './claudeSwapSupervisor'

function child(): ClaudeSwapChild & { emit: EventEmitter['emit']; stdout: EventEmitter; stderr: EventEmitter } {
  const processEvents = new EventEmitter()
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  return {
    pid: 123,
    stdout,
    stderr,
    kill: vi.fn(),
    on: processEvents.on.bind(processEvents),
    emit: processEvents.emit.bind(processEvents),
  }
}

function setup(enabled = false) {
  const children: ReturnType<typeof child>[] = []
  const scheduled: Array<{ callback: () => void; delay: number }> = []
  const spawn = vi.fn(() => {
    const next = child()
    children.push(next)
    return next
  })
  const writeEnabled = vi.fn(async () => undefined)
  const supervisor = new ClaudeSwapSupervisor({
    readEnabled: vi.fn(async () => enabled),
    writeEnabled,
    spawn,
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay })
      return callback
    },
    clearSchedule: vi.fn(),
  })
  return { supervisor, spawn, children, scheduled, writeEnabled }
}

describe('Claude swap supervisor', () => {
  it('keeps a below-threshold active account running when only peer usage is unreadable', async () => {
    const { supervisor, children, spawn } = setup()
    await supervisor.enable()
    children[0].stdout.emit('data', Buffer.from(
      '{"schemaVersion":1,"event":"poll","active":{"number":1},"headroomPct":{"1":80,"2":null},"threshold":95}\n'
      + '{"schemaVersion":1,"event":"no-switch","reason":"no-comparison"}\n',
    ))
    expect(supervisor.status()).toEqual({ state: 'running', lastErrorKind: null, warningKinds: ['NO_COMPARISON'] })
    expect(children[0].kill).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledOnce()
    children[0].stdout.emit('data', Buffer.from('{"schemaVersion":1,"event":"no-switch","reason":"below-threshold"}\n'))
    expect(supervisor.status()).toEqual({ state: 'running', lastErrorKind: null })
    children[0].stdout.emit('data', Buffer.from('{"schemaVersion":1,"event":"no-switch","reason":"no-comparison"}\n'))
    expect(supervisor.status()).toMatchObject({ state: 'blocked', lastErrorKind: 'NO_VIABLE_ACCOUNT' })
  })

  it('keeps exhaustion blocked when a quarantined peer is recovered', async () => {
    const { supervisor, children } = setup()
    await supervisor.enable()
    children[0].stdout.emit('data', Buffer.from(
      '{"schemaVersion":1,"event":"all-exhausted"}\n'
      + '{"schemaVersion":1,"event":"account-quarantined","number":"2"}\n',
    ))
    expect(supervisor.status()).toEqual({ state: 'blocked', lastErrorKind: 'ALL_ACCOUNTS_EXHAUSTED', warningKinds: ['ACCOUNT_NEEDS_REAUTH'] })
    children[0].stdout.emit('data', Buffer.from('{"schemaVersion":1,"event":"account-unquarantined","number":"2"}\n'))
    expect(supervisor.status()).toEqual({ state: 'blocked', lastErrorKind: 'ALL_ACCOUNTS_EXHAUSTED' })
  })

  it.each([null, 0, 5, -1, 101, '80'])('does not promote unreadable, exhausted, at-threshold or malformed active headroom %s', async headroom => {
    const { supervisor, children } = setup()
    await supervisor.enable()
    const emit = (event: object) => children[0].stdout.emit('data', Buffer.from(JSON.stringify({ schemaVersion: 1, ...event }) + '\n'))
    emit({ event: 'poll', active: { number: 1 }, headroomPct: { 1: headroom }, threshold: 95 })
    emit({ event: 'no-switch', reason: 'no-comparison' })
    expect(supervisor.status()).toMatchObject({ state: 'blocked', lastErrorKind: 'NO_VIABLE_ACCOUNT' })
  })

  it('replaces poll evidence and keeps process failures blocked through late output', async () => {
    const { supervisor, children } = setup()
    await supervisor.enable()
    const emit = (event: object) => children[0].stdout.emit('data', Buffer.from(JSON.stringify({ schemaVersion: 1, ...event }) + '\n'))
    emit({ event: 'poll', active: { number: 1 }, headroomPct: { 1: 80 }, threshold: 95 })
    emit({ event: 'poll', active: { number: 2 }, headroomPct: { 2: null }, threshold: 95 })
    emit({ event: 'no-switch', reason: 'no-comparison' })
    expect(supervisor.status()).toMatchObject({ state: 'blocked', lastErrorKind: 'NO_VIABLE_ACCOUNT' })
    emit({ event: 'poll', active: { number: 1 }, headroomPct: { 1: 80 }, threshold: 95 })
    children[0].emit('exit', 1, null)
    emit({ event: 'no-switch', reason: 'no-comparison' })
    expect(supervisor.status()).toMatchObject({ state: 'blocked', lastErrorKind: 'PROCESS_EXITED' })
  })

  it('persists enablement and runs exactly one consume-first auto child', async () => {
    const { supervisor, spawn, writeEnabled } = setup()

    await supervisor.enable()
    await supervisor.enable()

    expect(writeEnabled).toHaveBeenCalledWith(true)
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledWith('cswap', ['auto', '--strategy', 'consume-first', '--json'])
    expect(supervisor.status()).toEqual({ state: 'running', lastErrorKind: null })
  })

  it('restores an enabled supervisor and restarts with bounded backoff after exit', async () => {
    const { supervisor, spawn, children, scheduled } = setup(true)

    await supervisor.restore()
    children[0].emit('exit', 1, null)

    expect(supervisor.status()).toEqual({ state: 'blocked', lastErrorKind: 'PROCESS_EXITED' })
    expect(scheduled[0].delay).toBe(1_000)
    scheduled[0].callback()
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('stops the child and never exposes stdout credential fields in status', async () => {
    const { supervisor, children, writeEnabled } = setup()
    await supervisor.enable()
    children[0].stdout.emit('data', Buffer.from('{"email":"owner@example.com","accessToken":"secret"}\n'))

    expect(JSON.stringify(supervisor.status())).not.toContain('secret')
    expect(JSON.stringify(supervisor.status())).not.toContain('owner@example.com')

    let stopped = false
    const stopping = supervisor.stop().then(() => { stopped = true })
    await vi.waitFor(() => expect(children[0].kill).toHaveBeenCalledWith('SIGTERM'))
    expect(stopped).toBe(false)
    children[0].emit('exit', 0, 'SIGTERM')
    await stopping
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM')
    expect(writeEnabled).toHaveBeenLastCalledWith(false)
    expect(supervisor.status()).toEqual({ state: 'stopped', lastErrorKind: null })
  })

  it('does not report a successful stop when the child emits an error before exit', async () => {
    const { supervisor, children } = setup()
    await supervisor.enable()

    const stopping = supervisor.stop()
    await vi.waitFor(() => expect(children[0].kill).toHaveBeenCalledWith('SIGTERM'))
    children[0].emit('error', new Error('kill failed'))

    await expect(stopping).rejects.toThrow('claude-swap child failed while stopping')
  })

  it('retains a child that missed the stop deadline so a retry cannot skip termination', async () => {
    const { supervisor, children, scheduled } = setup()
    await supervisor.enable()

    const firstStop = supervisor.stop()
    await vi.waitFor(() => expect(children[0].kill).toHaveBeenCalledWith('SIGTERM'))
    scheduled[0].callback()
    await expect(firstStop).rejects.toThrow('claude-swap child did not exit after SIGTERM')
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL')
    expect(supervisor.status()).toEqual({ state: 'blocked', lastErrorKind: 'ROTATION_ERROR' })

    let retryStopped = false
    const retryStop = supervisor.stop().then(() => { retryStopped = true })
    await vi.waitFor(() => expect(children[0].kill).toHaveBeenCalledTimes(3))
    expect(retryStopped).toBe(false)
    children[0].emit('exit', 0, 'SIGTERM')
    await retryStop
  })

  it('settles to stopped when a retained child exits after the stop timeout', async () => {
    const { supervisor, children, scheduled } = setup()
    await supervisor.enable()

    const stopping = supervisor.stop()
    await vi.waitFor(() => expect(children[0].kill).toHaveBeenCalledWith('SIGTERM'))
    scheduled[0].callback()
    await expect(stopping).rejects.toThrow('claude-swap child did not exit after SIGTERM')

    children[0].emit('exit', 0, 'SIGKILL')

    expect(supervisor.status()).toEqual({ state: 'stopped', lastErrorKind: null })
  })

  it('keeps tracking a retained child after a later process error', async () => {
    const { supervisor, children, scheduled } = setup()
    await supervisor.enable()

    const firstStop = supervisor.stop()
    await vi.waitFor(() => expect(children[0].kill).toHaveBeenCalledWith('SIGTERM'))
    scheduled[0].callback()
    await expect(firstStop).rejects.toThrow('claude-swap child did not exit after SIGTERM')

    children[0].emit('error', new Error('still running'))
    expect(supervisor.status()).toEqual({ state: 'blocked', lastErrorKind: 'ROTATION_ERROR' })

    let retryStopped = false
    const retryStop = supervisor.stop().then(() => { retryStopped = true })
    await vi.waitFor(() => expect(children[0].kill).toHaveBeenCalledTimes(3))
    expect(retryStopped).toBe(false)
    children[0].emit('exit', 0, 'SIGKILL')
    await retryStop
  })

  it('restarts a child that could not be spawned', async () => {
    const { supervisor, children, scheduled } = setup()
    await supervisor.enable()
    children[0].pid = undefined

    children[0].emit('error', new Error('spawn failed'))

    expect(supervisor.status()).toEqual({ state: 'blocked', lastErrorKind: 'PROCESS_START_FAILED' })
    expect(scheduled[0].delay).toBe(1_000)
  })

  it('records only masked switch metadata from fragmented JSON events', async () => {
    const { supervisor, children } = setup()
    await supervisor.enable()
    children[0].stdout.emit('data', Buffer.from('{"schemaVersion":1,"event":"switch","ts":"2026-08-13T'))
    children[0].stdout.emit('data', Buffer.from('09:00:00Z","to":{"number":2,"email":"next@example.com"},"accessToken":"secret"}\n'))

    expect(supervisor.status()).toEqual({
      state: 'running',
      lastErrorKind: null,
      lastSwitchAt: '2026-08-13T09:00:00Z',
      activeAccount: 'n***@example.com',
    })
    expect(JSON.stringify(supervisor.status())).not.toContain('secret')
    expect(JSON.stringify(supervisor.status())).not.toContain('next@example.com')
  })

  it('keeps account exhaustion blocked through the next poll and clears on a healthy decision', async () => {
    const { supervisor, children } = setup()
    await supervisor.enable()

    children[0].stdout.emit('data', Buffer.from(
      '{"schemaVersion":1,"event":"all-exhausted","ts":"2026-08-13T09:00:00Z","earliestResetAt":null}\n',
    ))
    expect(supervisor.status()).toEqual({
      state: 'blocked',
      lastErrorKind: 'ALL_ACCOUNTS_EXHAUSTED',
    })

    children[0].stdout.emit('data', Buffer.from(
      '{"schemaVersion":1,"event":"poll","ts":"2026-08-13T09:01:00Z","active":{"number":1}}\n',
    ))
    expect(supervisor.status()).toEqual({
      state: 'blocked',
      lastErrorKind: 'ALL_ACCOUNTS_EXHAUSTED',
    })

    children[0].stdout.emit('data', Buffer.from(
      '{"schemaVersion":1,"event":"no-switch","ts":"2026-08-13T09:01:01Z","reason":"below-threshold"}\n',
    ))
    expect(supervisor.status()).toEqual({ state: 'running', lastErrorKind: null })
  })

  it('warns about a quarantined peer without overriding healthy rotation decisions', async () => {
    const { supervisor, children } = setup()
    await supervisor.enable()

    children[0].stdout.emit('data', Buffer.from(
      '{"schemaVersion":1,"event":"account-quarantined","number":"2","email":"dead@example.com","reason":"invalid-grant"}\n',
    ))
    expect(supervisor.status()).toEqual({
      state: 'running',
      lastErrorKind: null,
      warningKinds: ['ACCOUNT_NEEDS_REAUTH'],
    })
    expect(JSON.stringify(supervisor.status())).not.toContain('dead@example.com')

    children[0].stdout.emit('data', Buffer.from(
      '{"schemaVersion":1,"event":"no-switch","reason":"below-threshold"}\n',
    ))
    expect(supervisor.status()).toEqual({
      state: 'running',
      lastErrorKind: null,
      warningKinds: ['ACCOUNT_NEEDS_REAUTH'],
    })

    children[0].stdout.emit('data', Buffer.from(
      '{"schemaVersion":1,"event":"account-unquarantined","number":"2","email":"dead@example.com","reason":"credentials-replaced"}\n',
    ))
    expect(supervisor.status()).toEqual({ state: 'running', lastErrorKind: null })
  })

  it.each([
    'no-candidates',
    'no-comparison',
    'no-qualifying-candidate',
    'no-viable-target',
  ])('reports the cswap blocked outcome %s instead of running', async (reason) => {
    const { supervisor, children } = setup()
    await supervisor.enable()

    children[0].stdout.emit('data', Buffer.from(
      `${JSON.stringify({ schemaVersion: 1, event: 'no-switch', reason })}\n`,
    ))

    expect(supervisor.status()).toEqual({
      state: 'blocked',
      lastErrorKind: 'NO_VIABLE_ACCOUNT',
    })
  })

  it('resets restart backoff after receiving a healthy poll', async () => {
    const { supervisor, children, scheduled } = setup(true)
    await supervisor.restore()
    children[0].emit('exit', 1, null)
    scheduled[0].callback()

    children[1].stdout.emit('data', Buffer.from(
      '{"schemaVersion":1,"event":"poll","ts":"2026-08-13T09:01:00Z","active":{"number":1}}\n',
    ))
    children[1].emit('exit', 1, null)

    expect(scheduled[1].delay).toBe(1_000)
  })

  it('shuts down the child without disabling restart persistence', async () => {
    const { supervisor, children, writeEnabled } = setup(true)
    await supervisor.restore()

    supervisor.shutdown()

    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM')
    expect(writeEnabled).not.toHaveBeenCalled()
    expect(supervisor.status()).toEqual({ state: 'stopped', lastErrorKind: null })
  })

  it('keeps restart enabled when persisting stop fails', async () => {
    const { supervisor, children, scheduled, writeEnabled } = setup()
    await supervisor.enable()
    writeEnabled.mockRejectedValueOnce(new Error('disk full'))

    await expect(supervisor.stop()).rejects.toThrow('disk full')
    children[0].emit('exit', 1, null)

    expect(scheduled).toHaveLength(1)
    expect(supervisor.status()).toEqual({ state: 'blocked', lastErrorKind: 'PROCESS_EXITED' })
  })
})
