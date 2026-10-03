import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  exchangeAutomationMcpCallerGrant,
  linkAutomationProjectSession,
  linkSpawnedProjectSession,
  linkSpawnedProjectSessionInBackground,
} from './automationMcpCallerGrant'

describe('exchangeAutomationMcpCallerGrant', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('fails preflight when the daemon has no trusted Aplus MCP URL, and says why', async () => {
    const logDebug = vi.fn()
    await expect(exchangeAutomationMcpCallerGrant({
      configUrl: undefined,
      machineToken: 'machine-token',
      machineId: 'M-1',
      runId: 'R-1',
      claimToken: 'claim-token',
      logDebug,
    })).resolves.toEqual({ ok: false, error: 'Aplus MCP config URL is not configured' })
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('HAPPY_APLUS_MCP_CONFIG_URL'))
  })

  it('exchanges the run claim without exposing it in the config URL', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      grant: 'SIGNED-GRANT', projectId: 'P-1', expiresAt: Date.now() + 60_000,
      bindingStatus: 'BOUND', connectorPolicy: 'required', requiredConnectors: ['gmail'],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(exchangeAutomationMcpCallerGrant({
      configUrl: 'https://saycode.ai/api/me/mcp-config?existing=1',
      machineToken: 'machine-token',
      machineId: 'M-1',
      runId: 'R-1',
      claimToken: 'claim-token',
    })).resolves.toEqual({
      ok: true,
      value: {
        mcpCallerGrant: 'SIGNED-GRANT', mcpConfigProjectId: 'P-1',
        bindingStatus: 'BOUND', connectorPolicy: 'required', requiredConnectors: ['gmail'],
      },
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://saycode.ai/api/automation/mcp-caller-grant',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer machine-token' }),
        body: JSON.stringify({ machineId: 'M-1', runId: 'R-1', claimToken: 'claim-token' }),
      }),
    )
  })

  // specs/agent-browser-shared-profiles — on a shared Agent Browser machine Studio adds the session-user
  // attestation of the run's principal, so the run uses that user's browser profile.
  it("carries Studio's session-user attestation for the run, and drops a malformed one", async () => {
    const respond = (extra: Record<string, unknown>) => vi.fn(async () => new Response(JSON.stringify({
      grant: 'SIGNED-GRANT', projectId: 'P-1', expiresAt: Date.now() + 60_000,
      bindingStatus: 'BOUND', connectorPolicy: 'unspecified', requiredConnectors: [], ...extra,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const exchange = () => exchangeAutomationMcpCallerGrant({
      configUrl: 'https://saycode.ai/api/me/mcp-config', machineToken: 'machine-token', machineId: 'M-1', runId: 'R-1', claimToken: 'claim-token',
    })
    vi.stubGlobal('fetch', respond({ browserAttestation: 'abp2.h.p.s' }))
    await expect(exchange()).resolves.toMatchObject({ ok: true, value: { browserAttestation: 'abp2.h.p.s' } })
    for (const browserAttestation of [42, '', 'x'.repeat(4097)]) {
      vi.stubGlobal('fetch', respond({ browserAttestation }))
      const result = await exchange()
      expect(result).toMatchObject({ ok: true, value: { mcpCallerGrant: 'SIGNED-GRANT' } })
      expect(result.ok && result.value && 'browserAttestation' in result.value).toBe(false)
    }
  })

  // specs/automation-company-owner-identity R2 — 회사 happy 계정 소유
  // 자동화는 개인 커넥터 대상 사용자가 없어 서버가 no-grant 로 응답한다.
  // 후속 R12~R14에서는 no-grant도 정책과 함께 전달되어 executor가 fail-closed
  // 여부를 결정한다.
  it('preserves explicit no-grant policy metadata for executor preflight', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      grant: null, projectId: 'P-1', bindingStatus: 'BOUND',
      connectorPolicy: 'optional', requiredConnectors: ['gmail'],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    await expect(exchangeAutomationMcpCallerGrant({
      configUrl: 'https://saycode.ai/api/me/mcp-config',
      machineToken: 'machine-token',
      machineId: 'M-1',
      runId: 'R-1',
      claimToken: 'claim-token',
    })).resolves.toEqual({
      ok: true,
      value: {
        mcpConfigProjectId: 'P-1', bindingStatus: 'BOUND',
        connectorPolicy: 'optional', requiredConnectors: ['gmail'],
      },
    })
  })

  it.each([
    new Response('{}', { status: 403 }),
    new Response(JSON.stringify({ grant: '', projectId: 'P-1' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }),
    new Response(JSON.stringify({ grant: null, projectId: '' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }),
    new Response(JSON.stringify({
      grant: null, projectId: 'P-1', connectorPolicy: 'required',
      requiredConnectors: ['gmail!'],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify({
      grant: null, projectId: 'P-1', connectorPolicy: 'required', requiredConnectors: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ])('fails closed when the exchange rejects the run or returns an invalid grant', async (response) => {
    vi.stubGlobal('fetch', vi.fn(async () => response))

    const result = await exchangeAutomationMcpCallerGrant({
      configUrl: 'https://saycode.ai/api/me/mcp-config',
      machineToken: 'machine-token',
      machineId: 'M-1',
      runId: 'R-1',
      claimToken: 'claim-token',
    })

    expect(result.ok).toBe(false)
  })

  it.each([
    [409, 'AUTOMATION_EXECUTION_UNBOUND', 'EXECUTION_PRINCIPAL_UNBOUND'],
    [403, 'EXECUTION_PRINCIPAL_ACCESS_REVOKED', 'EXECUTION_PRINCIPAL_ACCESS_REVOKED'],
  ])('preserves safe principal precondition code from an exchange %s', async (
    status, responseCode, expectedCode,
  ) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: responseCode }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(exchangeAutomationMcpCallerGrant({
      configUrl: 'https://saycode.ai/api/me/mcp-config',
      machineToken: 'machine-token',
      machineId: 'M-1',
      runId: 'R-1',
      claimToken: 'claim-token',
    })).resolves.toEqual({
      ok: false,
      error: `caller grant exchange returned ${status}: ${responseCode}`,
      code: expectedCode,
    })
  })

  it('links the spawned session with the same run claim proof', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(linkAutomationProjectSession({
      configUrl: 'https://saycode.ai/api/me/mcp-config',
      machineToken: 'machine-token',
      machineId: 'M-1',
      runId: 'R-1',
      claimToken: 'claim-token',
      sessionId: 'S-1',
    })).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://saycode.ai/api/automation/session-link',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer machine-token' }),
        body: JSON.stringify({
          machineId: 'M-1', runId: 'R-1', claimToken: 'claim-token', sessionId: 'S-1',
        }),
      }),
    )
  })

  it('skips project linking when the daemon has no trusted Aplus MCP URL, and says why', async () => {
    const logDebug = vi.fn()
    await expect(linkAutomationProjectSession({
      configUrl: undefined,
      machineToken: 'machine-token',
      machineId: 'M-1',
      runId: 'R-1',
      claimToken: 'claim-token',
      sessionId: 'S-1',
      logDebug,
    })).resolves.toEqual({ ok: true, skipped: true })
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('HAPPY_APLUS_MCP_CONFIG_URL'))
  })

  it('keeps project linking retryable when the Aplus endpoint is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))

    await expect(linkAutomationProjectSession({
      configUrl: 'https://saycode.ai/api/me/mcp-config',
      machineToken: 'machine-token',
      machineId: 'M-1',
      runId: 'R-1',
      claimToken: 'claim-token',
      sessionId: 'S-1',
    })).resolves.toEqual({ ok: false, error: 'session link returned 503' })
  })
})

// specs/daemon-spawn-project-link — the same "tell A+ about this session" job as
// linkAutomationProjectSession, but for a session `agent spawn` created, which has no
// automation run behind it. A+ derives the project from the directory; the daemon does not
// know or decide which project this is.
describe('linkSpawnedProjectSession', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('posts the spawn directory so A+ can work out which project it belongs to', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, linked: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(linkSpawnedProjectSession({
      configUrl: 'https://saycode.ai/api/me/mcp-config',
      machineToken: 'machine-token',
      machineId: 'M-1',
      sessionId: 'S-1',
      directory: '/repo/app',
    })).resolves.toEqual({ ok: true })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://saycode.ai/api/agent-spawn/session-link',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer machine-token' }),
        body: JSON.stringify({ machineId: 'M-1', sessionId: 'S-1', directory: '/repo/app' }),
      }),
    )
  })

  it('skips when the daemon has no trusted Aplus URL — a plain Happy daemon is not a failure', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const logDebug = vi.fn()

    await expect(linkSpawnedProjectSession({
      configUrl: undefined,
      machineToken: 'machine-token',
      machineId: 'M-1',
      sessionId: 'S-1',
      directory: '/repo/app',
      logDebug,
    })).resolves.toEqual({ ok: true, skipped: true })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('HAPPY_APLUS_MCP_CONFIG_URL'))
  })

  it('reports a non-2xx as a plain result rather than throwing', async () => {
    // The caller runs on the spawn success path and must never see an exception (R2).
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))

    await expect(linkSpawnedProjectSession({
      configUrl: 'https://saycode.ai/api/me/mcp-config',
      machineToken: 'machine-token',
      machineId: 'M-1',
      sessionId: 'S-1',
      directory: '/repo/app',
    })).resolves.toEqual({ ok: false, error: 'spawned session link returned 503' })
  })

  it('reports a transport failure as a plain result rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up') }))

    await expect(linkSpawnedProjectSession({
      configUrl: 'https://saycode.ai/api/me/mcp-config',
      machineToken: 'machine-token',
      machineId: 'M-1',
      sessionId: 'S-1',
      directory: '/repo/app',
    })).resolves.toEqual({ ok: false, error: 'spawned session link failed' })
  })

  it('reports an unusable config URL as a plain result rather than throwing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(linkSpawnedProjectSession({
      configUrl: 'not a url',
      machineToken: 'machine-token',
      machineId: 'M-1',
      sessionId: 'S-1',
      directory: '/repo/app',
    })).resolves.toEqual({ ok: false, error: 'invalid Aplus MCP config URL' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// The spawn hook returns void so the spawn path cannot await it — which also means the spawn
// path cannot catch anything it leaves behind. That guarantee therefore has to live here.
describe('linkSpawnedProjectSessionInBackground', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const base = {
    configUrl: 'https://saycode.ai/api/me/mcp-config',
    machineToken: 'machine-token',
    machineId: 'M-1',
    sessionId: 'S-1',
    directory: '/repo/app',
  }

  it('returns immediately rather than waiting for the request', async () => {
    let settle: ((value: Response) => void) | undefined
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { settle = resolve })))

    expect(linkSpawnedProjectSessionInBackground(base)).toBeUndefined()

    expect(settle).toBeDefined()
    settle?.(new Response('{}', { status: 200 }))
  })

  it('logs a failed link at debug level without leaving a rejected promise behind', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up') }))
    const logDebug = vi.fn()

    linkSpawnedProjectSessionInBackground({ ...base, logDebug })
    await new Promise((resolve) => setImmediate(resolve))

    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('spawned session link failed'))
  })

  it('stays quiet when the link succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const logDebug = vi.fn()

    linkSpawnedProjectSessionInBackground({ ...base, logDebug })
    await new Promise((resolve) => setImmediate(resolve))

    expect(logDebug).not.toHaveBeenCalled()
  })
})
