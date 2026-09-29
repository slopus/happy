import { createLaunchReadinessGate } from './resumeGuards'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http, { IncomingMessage, ServerResponse } from 'node:http'
import { WebSocket } from 'ws'
import { AddressInfo } from 'node:net'
import { createPortRegistry } from './portRegistry'
import { startDaemonControlServer, type ManagedReportClaim } from './controlServer'
import { createManagedLaunchRegistry } from './launch/managedLaunchRegistry'
import {
  MANAGED_REPORT_CAPABILITY_HEADER,
  mintManagedReportCapability,
} from './launch/managedReportCapability'
import { createManagedReportVerifier } from './launch/verifyManagedReport'
import { randomBytes } from 'node:crypto'

const LAUNCH_SECRET = randomBytes(32)
import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers'

const realFetch = globalThis.fetch

/**
 * Every route requires `Authorization: Bearer <controlSecret>` (ADR-061). Each
 * describe block below shadows the module-local `fetch` with this — every
 * existing raw `fetch(...)` call site picks it up lexically, so route tests
 * exercise real auth without threading a header through ~30 call sites.
 */
function makeAuthedFetch(getSecret: () => string) {
  return (input: Parameters<typeof realFetch>[0], init?: RequestInit) =>
    realFetch(input, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), Authorization: `Bearer ${getSecret()}` },
    })
}

describe('controlServer port allocation endpoints', () => {
  const userId = 'test-user'
  let dir: string
  let baseUrl: string
  let stopServer: () => Promise<void>
  let controlSecret = ''
  const fetch = makeAuthedFetch(() => controlSecret)

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'control-server-'))
    const registry = createPortRegistry({
      filePath: path.join(dir, 'port-registry.json'),
      portMin: 30000,
      portMax: 30010,
      isPortBindable: async () => true,
    })
    const { port, stop, controlSecret: secret } = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: () => ({ stopped: false, reason: 'not-found' }),
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused in this test' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      portRegistry: registry,
    })
    baseUrl = `http://127.0.0.1:${port}`
    stopServer = stop
    controlSecret = secret
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
  let controlSecret = ''
  const fetch = makeAuthedFetch(() => controlSecret)

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'control-server-'))
    spawnRequests = []
    const registry = createPortRegistry({
      filePath: path.join(dir, 'port-registry.json'),
      portMin: 30000,
      portMax: 30010,
      isPortBindable: async () => true,
    })
    const { port, stop, controlSecret: secret } = await startDaemonControlServer({
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
    controlSecret = secret
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

  it('forwards axStep and bootstrapFiles to spawnSession', async () => {
    const bootstrapFiles = [{
      relativePath: '.aplus/agent/project-template.md',
      content: '# Project',
    }]
    const res = await fetch(`${baseUrl}/spawn-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        directory: dir,
        agent: 'claude',
        axStep: 'design',
        bootstrapFiles,
      }),
    })

    expect(res.status).toBe(200)
    expect(spawnRequests).toEqual([
      expect.objectContaining({
        axStep: 'design',
        bootstrapFiles,
      }),
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
    reporter?: { hostPid?: number }
  }>
  let controlSecret = ''
  const fetch = makeAuthedFetch(() => controlSecret)

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'control-server-'))
    runtimeReports = []
    const registry = createPortRegistry({
      filePath: path.join(dir, 'port-registry.json'),
      portMin: 30000,
      portMax: 30010,
      isPortBindable: async () => true,
    })
    const { port, stop, controlSecret: secret } = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: () => ({ stopped: false, reason: 'not-found' }),
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused in this test' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      onHappySessionRuntime: (sessionId, runtime, reporter) => {
        runtimeReports.push({ sessionId, runtime, ...(reporter ? { reporter } : {}) })
      },
      portRegistry: registry,
    })
    baseUrl = `http://127.0.0.1:${port}`
    stopServer = stop
    controlSecret = secret
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

  it('refuses a fractional turn-end timestamp at the door rather than merging it', async () => {
    const res = await fetch(`${baseUrl}/session-runtime`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1', lastTurnEndAt: 1.5 }),
    })
    expect(res.status).toBe(400)
    expect(runtimeReports).toHaveLength(0)
  })

  it('forwards cumulative assistant turn and provider token counters', async () => {
    const res = await fetch(`${baseUrl}/session-runtime`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'session-1',
        assistantTurns: 3,
        providerTokens: 1_200,
        reportSeq: 7,
      }),
    })

    expect(res.status).toBe(200)
    expect(runtimeReports[0].runtime).toMatchObject({ assistantTurns: 3, providerTokens: 1_200, reportSeq: 7 })
  })

  // The reporting process announces its own PID so the daemon can adopt a
  // session it isn't tracking (orphaned by a daemon restart) without guessing
  // the PID from a 14-day-old persisted record, which PID reuse can poison.
  it('forwards the reporting process PID when the session sends one', async () => {
    const res = await fetch(`${baseUrl}/session-runtime`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'session-1',
        thinking: false,
        hostPid: 4242,
      }),
    })

    expect(res.status).toBe(200)
    expect(runtimeReports[0].reporter).toEqual({ hostPid: 4242 })
  })

  // The resume skip-baseline is derived from this report: without it the daemon
  // falls back to the server-head seq and swallows dead-period messages.
  it('forwards lastProcessedSeq so resume can baseline at the delivered seq', async () => {
    const res = await fetch(`${baseUrl}/session-runtime`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'session-1',
        thinking: false,
        lastProcessedSeq: 621,
      }),
    })

    expect(res.status).toBe(200)
    expect((runtimeReports[0].runtime as { lastProcessedSeq?: number }).lastProcessedSeq).toBe(621)
  })

  // Sessions from an older CLI don't send hostPid; the endpoint must still work.
  it('accepts reports without a hostPid', async () => {
    const res = await fetch(`${baseUrl}/session-runtime`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1', thinking: false }),
    })

    expect(res.status).toBe(200)
    expect(runtimeReports[0].reporter).toBeUndefined()
  })
})

describe('controlServer port allocation — range exhaustion', () => {
  const userId = 'test-user'
  let dir: string
  let baseUrl: string
  let stopServer: () => Promise<void>
  let controlSecret = ''
  const fetch = makeAuthedFetch(() => controlSecret)

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'control-server-'))
    const registry = createPortRegistry({
      filePath: path.join(dir, 'port-registry.json'),
      portMin: 30000,
      portMax: 30001,
      isPortBindable: async () => true,
    })
    const { port, stop, controlSecret: secret } = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: () => ({ stopped: false, reason: 'not-found' }),
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      portRegistry: registry,
    })
    baseUrl = `http://127.0.0.1:${port}`
    stopServer = stop
    controlSecret = secret
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
  let controlSecret = ''
  const fetch = makeAuthedFetch(() => controlSecret)

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
    const { port, stop, controlSecret: secret } = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: () => ({ stopped: false, reason: 'not-found' }),
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      portRegistry: registry,
    })
    baseUrl = `http://127.0.0.1:${port}`
    stopServer = stop
    controlSecret = secret
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
  let controlSecret = ''
  const fetch = makeAuthedFetch(() => controlSecret)

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
    const { port, stop, controlSecret: secret } = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: () => ({ stopped: false, reason: 'not-found' }),
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      portRegistry: registry,
    })
    baseUrl = `http://127.0.0.1:${port}`
    stopServer = stop
    controlSecret = secret
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
  let controlSecret = ''
  const fetch = makeAuthedFetch(() => controlSecret)

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
    const { port, stop, controlSecret: secret } = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: () => ({ stopped: false, reason: 'not-found' }),
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      portRegistry: registry,
    })
    baseUrl = `http://127.0.0.1:${port}`
    stopServer = stop
    controlSecret = secret
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
  let received: Array<{ sessionId: string; context?: { source?: string; reason?: string; mode?: 'force' | 'if-idle' | 'if-not-busy' } }>
  let controlSecret = ''
  const fetch = makeAuthedFetch(() => controlSecret)

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'control-server-stop-'))
    received = []
    const registry = createPortRegistry({
      filePath: path.join(dir, 'port-registry.json'),
      portMin: 30000,
      portMax: 30010,
      isPortBindable: async () => true,
    })
    const { port, stop, controlSecret: secret } = await startDaemonControlServer({
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
    controlSecret = secret
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

// ADR-061 / specs/desktop-speed-breakthrough-local-direct T2: the control
// server is a loopback HTTP server with no auth today — any local process
// (any local user, on a shared machine) can call `/spawn-session` or
// `/proxy-http`. Every route must require the per-daemon-run Bearer secret,
// with no exceptions for routes that were "already" unauthenticated.
describe('controlServer authentication', () => {
  let dir: string
  let baseUrl: string
  let stopServer: () => Promise<void>
  let controlSecret: string

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'control-server-auth-'))
    const registry = createPortRegistry({
      filePath: path.join(dir, 'port-registry.json'),
      portMin: 30000,
      portMax: 30010,
      isPortBindable: async () => true,
    })
    const { port, stop, controlSecret: secret } = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: () => ({ stopped: false, reason: 'not-found' }),
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused in this test' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      portRegistry: registry,
    })
    baseUrl = `http://127.0.0.1:${port}`
    stopServer = stop
    controlSecret = secret
  })

  afterEach(async () => {
    await stopServer()
    rmSync(dir, { recursive: true, force: true })
  })

  it('issues a non-empty, per-run-unique secret', async () => {
    expect(controlSecret.length).toBeGreaterThanOrEqual(32)

    const other = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: () => ({ stopped: false, reason: 'not-found' }),
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      portRegistry: createPortRegistry({
        filePath: path.join(dir, 'port-registry-2.json'),
        portMin: 30020,
        portMax: 30030,
        isPortBindable: async () => true,
      }),
    })
    try {
      expect(other.controlSecret).not.toBe(controlSecret)
    } finally {
      await other.stop()
    }
  })

  it('rejects a request with no Authorization header', async () => {
    const res = await realFetch(`${baseUrl}/port-registry`)
    expect(res.status).toBe(401)
  })

  it('rejects a request with the wrong secret', async () => {
    const res = await realFetch(`${baseUrl}/port-registry`, {
      headers: { Authorization: 'Bearer not-the-secret' },
    })
    expect(res.status).toBe(401)
  })

  it('rejects a POST route with a body but no Authorization header — a route that was unauthenticated before ADR-061 must not be an exception', async () => {
    const res = await realFetch(`${baseUrl}/spawn-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: dir }),
    })
    expect(res.status).toBe(401)
  })

  it('accepts a request with the correct secret', async () => {
    const res = await realFetch(`${baseUrl}/port-registry`, {
      headers: { Authorization: `Bearer ${controlSecret}` },
    })
    expect(res.status).toBe(200)
  })
})

describe('managed runtime report paths — real HTTP, per-launch capability only', () => {
    const NOW = 1_800_000_000_000;
    let dir: string;
    let baseUrl: string;
    let stopServer: () => Promise<void>;
    let controlSecret = '';
    let registry: ReturnType<typeof createManagedLaunchRegistry>;
    const started: Array<{ sessionId: string }> = [];

    /**
     * registry 를 먼저 만들어 등록하고, **그 인스턴스로** verifier 를 만든 뒤
     * 부팅한다. 예전 순서(verifier 를 만든 다음 boot 안에서 registry 재생성)는
     * verifier 가 이전 테스트의 registry 를 붙잡거나 undefined 를 잡아, 이 파일
     * 전체를 돌릴 때만 우연히 통과하는 테스트를 만들었다.
     */
    function makeRegistry() {
        const created = createManagedLaunchRegistry();
        created.register({
            launchId: 'launch-1',
            scope: {
                operationKey: 'op-1', runId: 'run-1', attemptId: 'attempt-1',
                epoch: 3, workspaceId: 'ws-1', projectId: 'project-1',
            },
            sessionId: 'session-1',
            hostPids: [4242],
            encryption: { encryptionKey: 'key-1', encryptionVariant: 'dataKey' },
            expiresAt: NOW + 60_000,
            secret: LAUNCH_SECRET,
        });
        return created;
    }

    async function boot(makeVerifier?: (
        reg: ReturnType<typeof createManagedLaunchRegistry>,
    ) => (claim: ManagedReportClaim) => { ok: true } | { ok: false; reason: string }) {
        registry = makeRegistry();
        const sync = makeVerifier ? makeVerifier(registry) : undefined;
        // 검증기는 메모리 원장만 보므로 동기다. control server 의 의존성은
        // Promise 계약이고 호출부가 `await` 한다 — 여기서 감싸는 것이 그 사실을
        // 있는 그대로 옮기는 방법이다. 계약을 넓혀 동기 함수를 받게 만들면
        // 나중에 durable 원장으로 바뀔 때 그 차이가 조용히 사라진다.
        const verifier = sync ? async (claim: ManagedReportClaim) => sync(claim) : undefined;
        const ports = createPortRegistry({
            filePath: path.join(dir, 'port-registry.json'),
            portMin: 30000, portMax: 30010, isPortBindable: async () => true,
        });
        const server = await startDaemonControlServer({
            getChildren: () => [],
            stopSession: () => ({ stopped: false, reason: 'not-found' }),
            spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
            requestShutdown: () => {},
            onHappySessionWebhook: (sessionId) => { started.push({ sessionId }) },
            portRegistry: ports,
            managedRuntime: true,
            ...(verifier ? { verifyManagedReport: verifier } : {}),
        });
        baseUrl = `http://127.0.0.1:${server.port}`;
        stopServer = server.stop;
        controlSecret = server.controlSecret;
    }

    function post(pathname: string, body: unknown, headers: Record<string, string> = {}) {
        return realFetch(`${baseUrl}${pathname}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
        });
    }

    function capabilityFor(body: unknown, over: { seq?: number; kind?: 'session-started' | 'session-runtime' } = {}) {
        return mintManagedReportCapability({
            secret: LAUNCH_SECRET, launchId: 'launch-1',
            kind: over.kind ?? 'session-started', seq: over.seq ?? 1,
            expiresAt: NOW + 60_000, body,
        });
    }

    const STARTED_BODY = {
        sessionId: 'session-1',
        metadata: { hostPid: 4242, path: '/workspace/project' },
        encryption: {
            encryptionKey: 'key-1', encryptionVariant: 'dataKey',
            seq: 1, metadataVersion: 1, agentStateVersion: 1,
        },
    };

    beforeEach(() => {
        started.length = 0;
        dir = mkdtempSync(path.join(tmpdir(), 'control-server-managed-'));
    });

    afterEach(async () => {
        await stopServer();
        rmSync(dir, { recursive: true, force: true });
    });

    it('refuses a lifecycle report when no verifier is wired — activation stays closed', async () => {
        await boot();
        const res = await post('/session-started', STARTED_BODY, {
            [MANAGED_REPORT_CAPABILITY_HEADER]: capabilityFor(STARTED_BODY),
        });
        expect(res.status).toBe(403);
        expect(started).toHaveLength(0);
    });

    it('does not accept the daemon-wide control secret in place of a capability', async () => {
        await boot((reg) => createManagedReportVerifier({ registry: reg, now: () => NOW }));
        const res = await post('/session-started', STARTED_BODY, {
            Authorization: `Bearer ${controlSecret}`,
        });
        // 전역 secret 은 어느 launch 인지 증명하지 못한다.
        expect(res.status).toBe(403);
        expect(started).toHaveLength(0);
    });

    it('accepts a report carrying a valid per-launch capability and no bearer', async () => {
        await boot((reg) => createManagedReportVerifier({ registry: reg, now: () => NOW }));
        const res = await post('/session-started', STARTED_BODY, {
            [MANAGED_REPORT_CAPABILITY_HEADER]: capabilityFor(STARTED_BODY),
        });
        expect(res.status).toBe(200);
        expect(started).toEqual([{ sessionId: 'session-1' }]);
    });

    it('refuses the same report replayed on the wire', async () => {
        await boot((reg) => createManagedReportVerifier({ registry: reg, now: () => NOW }));
        const capability = capabilityFor(STARTED_BODY);
        expect((await post('/session-started', STARTED_BODY, {
            [MANAGED_REPORT_CAPABILITY_HEADER]: capability,
        })).status).toBe(200);
        const replayed = await post('/session-started', STARTED_BODY, {
            [MANAGED_REPORT_CAPABILITY_HEADER]: capability,
        });
        expect(replayed.status).toBe(403);
        expect(started).toHaveLength(1);
    });

    it('refuses a body whose hostPid was swapped after signing', async () => {
        await boot((reg) => createManagedReportVerifier({ registry: reg, now: () => NOW }));
        const capability = capabilityFor(STARTED_BODY);
        const res = await post(
            '/session-started',
            { ...STARTED_BODY, metadata: { hostPid: 9999, path: '/workspace/project' } },
            { [MANAGED_REPORT_CAPABILITY_HEADER]: capability },
        );
        expect(res.status).toBe(403);
        expect(started).toHaveLength(0);
    });

    it('refuses a launch reporting a session it was not registered for', async () => {
        await boot((reg) => createManagedReportVerifier({ registry: reg, now: () => NOW }));
        const body = { ...STARTED_BODY, sessionId: 'session-other' };
        const res = await post('/session-started', body, {
            [MANAGED_REPORT_CAPABILITY_HEADER]: capabilityFor(body),
        });
        expect(res.status).toBe(403);
        expect(started).toHaveLength(0);
    });

    it('refuses a hostPid that is present but not a positive safe integer', async () => {
        await boot((reg) => createManagedReportVerifier({ registry: reg, now: () => NOW }));
        const body = {
            ...STARTED_BODY,
            metadata: { hostPid: '4242', path: '/workspace/project' },
        };
        const res = await post('/session-started', body, {
            [MANAGED_REPORT_CAPABILITY_HEADER]: capabilityFor(body),
        });
        expect(res.status).toBe(403);
        expect(started).toHaveLength(0);
    });

    it('still refuses every non-report control path on a managed runtime', async () => {
        await boot((reg) => createManagedReportVerifier({ registry: reg, now: () => NOW }));
        const res = await post('/spawn-session', { directory: '/workspace/project' }, {
            [MANAGED_REPORT_CAPABILITY_HEADER]: capabilityFor(STARTED_BODY),
        });
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ code: 'MANAGED_CAPABILITY_REQUIRED' });
    });
});

describe('standalone Windows control admission', () => {
  it('keeps lifecycle, drain and terminal routes while refusing host spawn and unknown endpoints', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'trial-control-'))
    const { StandaloneDrain } = await import('./standaloneDrain')
    const drain = new StandaloneDrain({ instanceId: 'trial-instance',
      targets: [{ platform: 'win32', arch: 'x64', provider: 'codex', mode: 'standard' }],
      freeze: async () => ({ launchIds: [], unresolved: false }),
      drain: async () => ({ stored: true, runtimeExited: true, jobEmpty: true }),
    })
    const server = await startDaemonControlServer({
      standaloneDrain: drain, getChildren: () => [], stopSession: () => ({ stopped: false, reason: 'not-found' }),
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }), requestShutdown: () => {}, onHappySessionWebhook: () => {},
      portRegistry: createPortRegistry({ filePath: path.join(dir, 'ports.json'), portMin: 30000, portMax: 30010, isPortBindable: async () => true }),
    })
    const request = (route: string, secret = server.controlSecret) => realFetch(`http://127.0.0.1:${server.port}${route}`, {
      method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: '{}',
    })
    try {
      for (const route of ['/start-server', '/stop-server', '/browser/request', '/proxy-http', '/terminal', '/future-host-spawn']) {
        const response = await request(route)
        expect(response.status).toBe(403)
        expect(await response.json()).toMatchObject({ code: 'STANDALONE_WINDOWS_TRIAL_UNSUPPORTED' })
      }
      expect((await request('/stop')).status).toBe(409)
      expect((await request('/list')).status).toBe(200)
      expect((await request('/standalone-drain/capabilities')).status).toBe(200)
      expect((await request('/list', 'wrong-secret')).status).toBe(401)
      // W0-5h: every shell is rooted in the runtime's pty host and closed on drain, so the
      // loopback terminal socket is available; it keeps the same secret check.
      const upgrade = (secret: string) => new Promise<string>(resolve => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}/terminal?token=${encodeURIComponent(secret)}`)
        ws.on('open', () => { ws.close(); resolve('open') })
        ws.on('error', () => resolve('refused'))
      })
      expect(await upgrade(server.controlSecret)).toBe('open')
      expect(await upgrade('wrong-secret')).toBe('refused')
    } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }) }
  })
})

it('refuses an early authenticated spawn before reading uninitialized dependencies and accepts retry after startup', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'control-startup-'))
  const readiness = createLaunchReadinessGate()
  let touches = 0
  let dependency = (): { sessionId: string } => { throw new ReferenceError('lessonStudioOrigin before initialization') }
  const server = await startDaemonControlServer({
    getChildren: () => [], stopSession: () => ({ stopped: false, reason: 'not-found' }),
    spawnSession: async () => {
      if (!readiness.isReady()) return { type: 'error', errorMessage: 'Daemon is initializing; retry the launch shortly' }
      touches += 1
      return { type: 'success', sessionId: dependency().sessionId }
    },
    requestShutdown: () => {}, onHappySessionWebhook: () => {},
    portRegistry: createPortRegistry({ filePath: path.join(dir, 'ports.json'), portMin: 30000, portMax: 30010, isPortBindable: async () => true }),
  })
  const spawn = () => realFetch(`http://127.0.0.1:${server.port}/spawn-session`, {
    method: 'POST', headers: { Authorization: `Bearer ${server.controlSecret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ directory: dir, agent: 'codex' }),
  })
  try {
    const early = await spawn()
    expect(early.status).toBe(500)
    expect(await early.json()).toEqual({ success: false, error: 'Daemon is initializing; retry the launch shortly' })
    expect(touches).toBe(0)
    // Simulate the actual listener-before-network-bootstrap TDZ ordering.
    const lessonHost = { sessionId: 'initialized-session' }
    // The real callback below uses the same dependency through its closure.
    dependency = () => lessonHost
    readiness.markReady()
    const retry = await spawn()
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ sessionId: 'initialized-session' })
    expect(touches).toBe(1)
  } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }) }
})

it.each(['standalone-unowned', 'standalone-blocked'] as const)('preserves %s on the authenticated stop-session boundary', async reason => {
  const dir = mkdtempSync(path.join(tmpdir(), 'control-stop-refusal-'))
  const server = await startDaemonControlServer({
    getChildren: () => [], stopSession: () => ({ stopped: false, reason, detail: 'unavailable' }),
    spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }), requestShutdown: () => {}, onHappySessionWebhook: () => {},
    portRegistry: createPortRegistry({ filePath: path.join(dir, 'ports.json'), portMin: 30000, portMax: 30010, isPortBindable: async () => true }),
  })
  try {
    const response = await realFetch(`http://127.0.0.1:${server.port}/stop-session`, { method: 'POST',
      headers: { Authorization: `Bearer ${server.controlSecret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-1' }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ stopped: false, reason, detail: 'unavailable' })
  } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }) }
})
