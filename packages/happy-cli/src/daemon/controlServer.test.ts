import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http, { IncomingMessage, ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { createPortRegistry } from './portRegistry'
import { startDaemonControlServer } from './controlServer'
import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers'

describe('controlServer port allocation endpoints', () => {
  const userId = 'test-user'
  let dir: string
  let baseUrl: string
  let stopServer: () => Promise<void>

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'control-server-'))
    const registry = createPortRegistry({
      filePath: path.join(dir, 'port-registry.json'),
      portMin: 30000,
      portMax: 30010,
      isPortBindable: async () => true,
    })
    const { port, stop } = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: () => ({ stopped: false, reason: 'not-found' }),
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused in this test' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      portRegistry: registry,
    })
    baseUrl = `http://127.0.0.1:${port}`
    stopServer = stop
  })

  afterEach(async () => {
    await stopServer()
    rmSync(dir, { recursive: true, force: true })
  })

  const allocate = async (projectId: string) => {
    const res = await fetch(`${baseUrl}/allocate-port`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, projectId }),
    })
    return { status: res.status, body: (await res.json()) as { port?: number; reused?: boolean; error?: string } }
  }

  const release = async (projectId: string) => {
    const res = await fetch(`${baseUrl}/release-port`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, projectId }),
    })
    return { status: res.status, body: (await res.json()) as { released?: boolean } }
  }

  const list = async () => {
    const res = await fetch(`${baseUrl}/port-registry`)
    return { status: res.status, body: (await res.json()) as { entries: Array<{ projectId: string; port: number; allocatedAt: number }> } }
  }

  it('POST /allocate-port returns a fresh port for a new projectId', async () => {
    const { status, body } = await allocate('proj-a')
    expect(status).toBe(200)
    expect(body.port).toBe(30000)
    expect(body.reused).toBe(false)
  })

  it('POST /allocate-port returns the same port when the projectId repeats', async () => {
    const first = await allocate('proj-a')
    const second = await allocate('proj-a')
    expect(second.body.port).toBe(first.body.port)
    expect(second.body.reused).toBe(true)
  })

  it('POST /allocate-port assigns distinct ports to different projectIds', async () => {
    const a = await allocate('proj-a')
    const b = await allocate('proj-b')
    expect(a.body.port).not.toBe(b.body.port)
  })

  it('GET /port-registry exposes all current allocations', async () => {
    await allocate('proj-a')
    await allocate('proj-b')
    const { status, body } = await list()
    expect(status).toBe(200)
    const ids = body.entries.map((e) => e.projectId).sort()
    expect(ids).toEqual(['proj-a', 'proj-b'])
    for (const entry of body.entries) {
      expect(entry.port).toBeGreaterThanOrEqual(30000)
      expect(entry.allocatedAt).toBeGreaterThan(0)
    }
  })

  it('POST /release-port removes an existing entry', async () => {
    await allocate('proj-a')
    const { status, body } = await release('proj-a')
    expect(status).toBe(200)
    expect(body.released).toBe(true)
    const registry = await list()
    expect(registry.body.entries.find((e) => e.projectId === 'proj-a')).toBeUndefined()
  })

  it('POST /release-port returns released=false for unknown projectId', async () => {
    const { body } = await release('ghost')
    expect(body.released).toBe(false)
  })

  it('POST /allocate-port validates projectId is a non-empty string', async () => {
    const res = await fetch(`${baseUrl}/allocate-port`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: '' }),
    })
    expect(res.status).toBe(400)
  })

  const getPort = async (query: string) => {
    const res = await fetch(`${baseUrl}/get-port${query}`)
    const body = (await res.json()) as { port?: number | null; error?: string }
    return { status: res.status, body }
  }

  it('GET /get-port returns the registered port for an allocated projectId', async () => {
    const alloc = await allocate('proj-a')
    const { status, body } = await getPort(`?userId=${userId}&projectId=proj-a`)
    expect(status).toBe(200)
    expect(body.port).toBe(alloc.body.port)
  })

  it('GET /get-port returns port=null for an unknown projectId', async () => {
    const { status, body } = await getPort(`?userId=${userId}&projectId=ghost`)
    expect(status).toBe(200)
    expect(body.port).toBeNull()
  })

  it('GET /get-port rejects missing projectId', async () => {
    const { status } = await getPort('')
    expect(status).toBe(400)
  })

  it('GET /get-port rejects empty projectId', async () => {
    const { status } = await getPort(`?userId=${userId}&projectId=`)
    expect(status).toBe(400)
  })
})

describe('controlServer POST /spawn-session', () => {
  let dir: string
  let baseUrl: string
  let stopServer: () => Promise<void>
  let spawnRequests: SpawnSessionOptions[]

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'control-server-'))
    spawnRequests = []
    const registry = createPortRegistry({
      filePath: path.join(dir, 'port-registry.json'),
      portMin: 30000,
      portMax: 30010,
      isPortBindable: async () => true,
    })
    const { port, stop } = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: () => ({ stopped: false, reason: 'not-found' }),
      spawnSession: async (options) => {
        spawnRequests.push(options)
        return { type: 'success', sessionId: 'happy-opencode-session' }
      },
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      portRegistry: registry,
    })
    baseUrl = `http://127.0.0.1:${port}`
    stopServer = stop
  })

  afterEach(async () => {
    await stopServer()
    rmSync(dir, { recursive: true, force: true })
  })

  it('accepts opencode and forwards it to spawnSession', async () => {
    const res = await fetch(`${baseUrl}/spawn-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: dir, agent: 'opencode' }),
    })
    const body = (await res.json()) as { success?: boolean; sessionId?: string }

    expect(res.status).toBe(200)
    expect(body).toEqual({
      success: true,
      sessionId: 'happy-opencode-session',
      approvedNewDirectoryCreation: true,
    })
    expect(spawnRequests).toEqual([
      expect.objectContaining({ directory: dir, agent: 'opencode' }),
    ])
  })
})

describe('controlServer POST /session-runtime', () => {
  let dir: string
  let baseUrl: string
  let stopServer: () => Promise<void>
  let runtimeReports: Array<{
    sessionId: string
    runtime: { thinking?: boolean; hasOpenToolCall?: boolean; updatedAt: number }
  }>

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'control-server-'))
    runtimeReports = []
    const registry = createPortRegistry({
      filePath: path.join(dir, 'port-registry.json'),
      portMin: 30000,
      portMax: 30010,
      isPortBindable: async () => true,
    })
    const { port, stop } = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: () => ({ stopped: false, reason: 'not-found' }),
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused in this test' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      onHappySessionRuntime: (sessionId, runtime) => {
        runtimeReports.push({ sessionId, runtime })
      },
      portRegistry: registry,
    })
    baseUrl = `http://127.0.0.1:${port}`
    stopServer = stop
  })

  afterEach(async () => {
    await stopServer()
    rmSync(dir, { recursive: true, force: true })
  })

  it('accepts runtime busy state reports from a session process', async () => {
    const res = await fetch(`${baseUrl}/session-runtime`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'session-1',
        thinking: true,
        hasOpenToolCall: true,
      }),
    })
    const body = (await res.json()) as { status?: string }

    expect(res.status).toBe(200)
    expect(body).toEqual({ status: 'ok' })
    expect(runtimeReports).toHaveLength(1)
    expect(runtimeReports[0]).toMatchObject({
      sessionId: 'session-1',
      runtime: {
        thinking: true,
        hasOpenToolCall: true,
      },
    })
    expect(runtimeReports[0].runtime.updatedAt).toBeGreaterThan(0)
  })
})

describe('controlServer port allocation — range exhaustion', () => {
  const userId = 'test-user'
  let dir: string
  let baseUrl: string
  let stopServer: () => Promise<void>

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'control-server-'))
    const registry = createPortRegistry({
      filePath: path.join(dir, 'port-registry.json'),
      portMin: 30000,
      portMax: 30001,
      isPortBindable: async () => true,
    })
    const { port, stop } = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: () => ({ stopped: false, reason: 'not-found' }),
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      portRegistry: registry,
    })
    baseUrl = `http://127.0.0.1:${port}`
    stopServer = stop
  })

  afterEach(async () => {
    await stopServer()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns 503 when the range is exhausted', async () => {
    await fetch(`${baseUrl}/allocate-port`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, projectId: 'a' }),
    })
    await fetch(`${baseUrl}/allocate-port`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, projectId: 'b' }),
    })
    const res = await fetch(`${baseUrl}/allocate-port`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, projectId: 'c' }),
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toMatch(/No available port/)
  })
})

describe('controlServer POST /proxy-http', () => {
  let dir: string
  let baseUrl: string
  let stopServer: () => Promise<void>
  let upstream: { port: number; stop: () => Promise<void> } | null = null

  const startUpstream = async (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
    const srv = http.createServer(handler)
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()))
    const port = (srv.address() as AddressInfo).port
    upstream = { port, stop: () => new Promise<void>((r) => srv.close(() => r())) }
    return port
  }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'control-server-'))
    const registry = createPortRegistry({
      filePath: path.join(dir, 'port-registry.json'),
      portMin: 30000,
      portMax: 30010,
      isPortBindable: async () => true,
    })
    const { port, stop } = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: () => ({ stopped: false, reason: 'not-found' }),
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      portRegistry: registry,
    })
    baseUrl = `http://127.0.0.1:${port}`
    stopServer = stop
  })

  afterEach(async () => {
    await stopServer()
    if (upstream) {
      await upstream.stop()
      upstream = null
    }
    rmSync(dir, { recursive: true, force: true })
  })

  const proxy = async (body: unknown) =>
    fetch(`${baseUrl}/proxy-http`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('relays a GET and returns the upstream status + base64 body', async () => {
    const port = await startUpstream((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('hello remote')
    })
    const res = await proxy({ port, method: 'GET', path: '/', headers: {}, bodyB64: null })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { status: number; bodyB64: string; truncated: boolean }
    expect(json.status).toBe(200)
    expect(Buffer.from(json.bodyB64, 'base64').toString()).toBe('hello remote')
    expect(json.truncated).toBe(false)
  })

  it('forwards a POST body and surfaces upstream response', async () => {
    const port = await startUpstream((req, res) => {
      let data = ''
      req.on('data', (c) => { data += c.toString() })
      req.on('end', () => {
        res.writeHead(201)
        res.end(`echo:${data}`)
      })
    })
    const res = await proxy({
      port, method: 'POST', path: '/echo',
      headers: { 'Content-Type': 'text/plain' },
      bodyB64: Buffer.from('ping').toString('base64'),
    })
    const json = (await res.json()) as { status: number; bodyB64: string }
    expect(json.status).toBe(201)
    expect(Buffer.from(json.bodyB64, 'base64').toString()).toBe('echo:ping')
  })

  it('returns 502 with CONNECTION_REFUSED when the port has no listener', async () => {
    // Grab a port and immediately free it
    const probe = http.createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()))
    const freePort = (probe.address() as AddressInfo).port
    await new Promise<void>((r) => probe.close(() => r()))

    const res = await proxy({ port: freePort, method: 'GET', path: '/', headers: {}, bodyB64: null })
    expect(res.status).toBe(502)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('CONNECTION_REFUSED')
  })

  it('returns 400 for a non-slash path', async () => {
    const res = await proxy({ port: 3000, method: 'GET', path: 'bare', headers: {}, bodyB64: null })
    expect(res.status).toBe(400)
  })

  it('returns 400 for a port outside the valid range', async () => {
    const res = await proxy({ port: 42, method: 'GET', path: '/', headers: {}, bodyB64: null })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code?: string }
    expect(json.code === 'INVALID_PORT' || res.status === 400).toBe(true)
  })
})

describe('controlServer POST /start-server', () => {
  let dir: string
  let baseUrl: string
  let stopServer: () => Promise<void>
  const spawnedPids: number[] = []

  const kill = (pid: number) => {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'control-server-'))
    const registry = createPortRegistry({
      filePath: path.join(dir, 'port-registry.json'),
      portMin: 30000,
      portMax: 30010,
      isPortBindable: async () => true,
    })
    const { port, stop } = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: () => ({ stopped: false, reason: 'not-found' }),
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      portRegistry: registry,
    })
    baseUrl = `http://127.0.0.1:${port}`
    stopServer = stop
  })

  afterEach(async () => {
    for (const pid of spawnedPids) kill(pid)
    spawnedPids.length = 0
    await stopServer()
    rmSync(dir, { recursive: true, force: true })
  })

  const post = async (body: unknown) =>
    fetch(`${baseUrl}/start-server`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  const writeSleepScript = (ms: number): string => {
    const p = path.join(dir, 'sleep.js')
    require('node:fs').writeFileSync(p, `setTimeout(() => process.exit(0), ${ms})`)
    return p
  }

  it('spawns and returns 200 with the pid', async () => {
    const script = writeSleepScript(1500)
    const res = await post({ command: `node ${script}`, cwd: dir })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { success: boolean; pid: number }
    expect(json.success).toBe(true)
    expect(Number.isInteger(json.pid)).toBe(true)
    expect(() => process.kill(json.pid, 0)).not.toThrow()
    spawnedPids.push(json.pid)
  })

  it('returns 400 CWD_NOT_FOUND for a missing working directory', async () => {
    const res = await post({ command: 'node foo.js', cwd: '/nope/xyz/123' })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('CWD_NOT_FOUND')
  })

  it('returns 400 INVALID_COMMAND for a shell-metachar command', async () => {
    const res = await post({ command: 'node a.js && echo hi', cwd: dir })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('INVALID_COMMAND')
  })

  it('returns 500 EXEC_NOT_FOUND when the binary is not on PATH', async () => {
    const res = await post({ command: 'nonexistent-binary-xyz-123', cwd: dir })
    expect(res.status).toBe(500)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('EXEC_NOT_FOUND')
  })

  it('injects env vars into the spawned process', async () => {
    const outPath = path.join(dir, 'out.txt')
    const scriptPath = path.join(dir, 'env-probe.js')
    require('node:fs').writeFileSync(scriptPath, `
const fs = require('fs')
fs.writeFileSync(process.env.OUT, process.env.TEST_VAR || '')
setTimeout(() => process.exit(0), 1500)
`)
    const res = await post({
      command: `node ${scriptPath}`,
      cwd: dir,
      env: { OUT: outPath, TEST_VAR: 'elastic_id=1' },
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { pid: number }
    spawnedPids.push(json.pid)
    // Allow the child to fsync before we assert.
    await new Promise((r) => setTimeout(r, 150))
    expect(require('node:fs').existsSync(outPath)).toBe(true)
    expect(require('node:fs').readFileSync(outPath, 'utf-8')).toBe('elastic_id=1')
  })

  it('rejects 400 on missing command/cwd fields', async () => {
    const r1 = await post({ cwd: dir })
    expect(r1.status).toBe(400)
    const r2 = await post({ command: 'node foo.js' })
    expect(r2.status).toBe(400)
  })
})

describe('controlServer POST /stop-server', () => {
  let dir: string
  let baseUrl: string
  let stopServer: () => Promise<void>
  const spawnedPids: number[] = []

  const killPid = (pid: number) => {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'control-server-'))
    const registry = createPortRegistry({
      filePath: path.join(dir, 'port-registry.json'),
      portMin: 30000,
      portMax: 30010,
      isPortBindable: async () => true,
    })
    const { port, stop } = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: () => ({ stopped: false, reason: 'not-found' }),
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      portRegistry: registry,
    })
    baseUrl = `http://127.0.0.1:${port}`
    stopServer = stop
  })

  afterEach(async () => {
    for (const pid of spawnedPids) killPid(pid)
    spawnedPids.length = 0
    await stopServer()
    rmSync(dir, { recursive: true, force: true })
  })

  const startPost = async (body: unknown) =>
    fetch(`${baseUrl}/start-server`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  const stopPost = async (body: unknown) =>
    fetch(`${baseUrl}/stop-server`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('stops a spawned server and returns sentSignal=SIGTERM', async () => {
    const scriptPath = path.join(dir, 'sleep.js')
    require('node:fs').writeFileSync(scriptPath, `setTimeout(() => process.exit(0), 15000)`)
    const startRes = await startPost({ command: `node ${scriptPath}`, cwd: dir })
    expect(startRes.status).toBe(200)
    const { pid } = (await startRes.json()) as { pid: number }
    spawnedPids.push(pid)
    expect(() => process.kill(pid, 0)).not.toThrow()

    const stopRes = await stopPost({ pid })
    expect(stopRes.status).toBe(200)
    const body = (await stopRes.json()) as { stopped: boolean; sentSignal: string }
    expect(body).toEqual({ stopped: true, sentSignal: 'SIGTERM' })
    await new Promise((r) => setTimeout(r, 50))
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('returns 404 NO_SUCH_PROCESS for an unknown pid', async () => {
    const res = await stopPost({ pid: 0x7fff_ffff })
    expect(res.status).toBe(404)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('NO_SUCH_PROCESS')
  })

  it('returns 400 for non-positive / non-integer pid', async () => {
    const r1 = await stopPost({ pid: 0 })
    expect(r1.status).toBe(400)
    const r2 = await stopPost({ pid: -1 })
    expect(r2.status).toBe(400)
    const r3 = await stopPost({ pid: 1.5 })
    expect(r3.status).toBe(400)
  })

  it('rejects 400 on missing pid field', async () => {
    const res = await stopPost({})
    expect(res.status).toBe(400)
  })
})

describe('controlServer /stop-session v2 contract', () => {
  let dir: string
  let baseUrl: string
  let stopServer: () => Promise<void>
  let received: Array<{ sessionId: string; context?: { source?: string; reason?: string; mode?: 'force' | 'if-idle' } }>

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'control-server-stop-'))
    received = []
    const registry = createPortRegistry({
      filePath: path.join(dir, 'port-registry.json'),
      portMin: 30000,
      portMax: 30010,
      isPortBindable: async () => true,
    })
    const { port, stop } = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: (sessionId, context) => {
        received.push({ sessionId, ...(context !== undefined ? { context } : {}) })
        if (sessionId === 'session-active') {
          return {
            stopped: false,
            reason: 'active',
            guard: 'thinking',
            activity: { thinking: true, hasOpenToolCall: false, pendingUserInput: false },
          }
        }
        if (sessionId === 'session-live') {
          return { stopped: true }
        }
        return { stopped: false, reason: 'not-found' }
      },
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused in this test' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      portRegistry: registry,
    })
    baseUrl = `http://127.0.0.1:${port}`
    stopServer = stop
  })

  afterEach(async () => {
    await stopServer()
    rmSync(dir, { recursive: true, force: true })
  })

  const stopSessionPost = async (body: Record<string, unknown>) => {
    const res = await fetch(`${baseUrl}/stop-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  it('passes mode through and returns a structured refusal for an active session', async () => {
    const { status, body } = await stopSessionPost({
      sessionId: 'session-active',
      source: 'project-session-idle-stop',
      mode: 'if-idle',
    })

    expect(status).toBe(200)
    expect(body).toEqual({ success: false, stopped: false, reason: 'active', guard: 'thinking' })
    expect(received).toEqual([{
      sessionId: 'session-active',
      context: { source: 'project-session-idle-stop', mode: 'if-idle' },
    }])
  })

  it('returns stopped:true alongside legacy success for a real stop', async () => {
    const { status, body } = await stopSessionPost({ sessionId: 'session-live' })
    expect(status).toBe(200)
    expect(body).toEqual({ success: true, stopped: true })
  })

  it('marks an untracked session as not-found without a guard', async () => {
    const { status, body } = await stopSessionPost({ sessionId: 'session-missing' })
    expect(status).toBe(200)
    expect(body).toEqual({ success: false, stopped: false, reason: 'not-found' })
  })
})
