import { describe, expect, it, vi, afterEach } from 'vitest'
import fastify from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { attachLocalToolAgentRelayRoutes, requestLocalToolAgent, localToolAgentContext } from './localToolAgentRelay'
afterEach(() => vi.unstubAllEnvs())
describe('Desktop local tool relay discovery', () => {
  it('expires registrations, refuses live takeover and prevents stale unregister', async () => {
    let now = Date.now(); const app = fastify()
    app.setSerializerCompiler(serializerCompiler); app.setValidatorCompiler(validatorCompiler)
    attachLocalToolAgentRelayRoutes(app, () => now)
    const one = 'a'.repeat(43); const two = 'b'.repeat(43)
    expect((await app.inject({ method: 'GET', url: '/local-tools/relay' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'PUT', url: '/local-tools/relay', payload: { version: 1, port: 12345, secret: one } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'PUT', url: '/local-tools/relay', payload: { version: 1, port: 12345, secret: two } })).statusCode).toBe(500)
    await app.inject({ method: 'DELETE', url: '/local-tools/relay', payload: { secret: two } })
    expect((await app.inject({ method: 'GET', url: '/local-tools/relay' })).json().secret).toBe(one)
    now += 30001
    expect((await app.inject({ method: 'GET', url: '/local-tools/relay' })).statusCode).toBe(404)
    await app.close()
  })
  it('keeps relay URLs loopback-only and trusted context wins over input', async () => {
    const context = { serverUrl: 'https://saycode.test', machineId: 'M1', sessionId: 'S1', projectId: 'P1', callerGrant: 'opaque-grant' }
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(fetcher.mock.calls.length === 1
      ? { version: 1, port: 12345, secret: 'a'.repeat(43), expiresAt: Date.now() + 30000 } : { version: 1, state: 'succeeded' })))
    expect(await requestLocalToolAgent(context, { action: 'run', sessionId: 'S-other', callerGrant: 'forged' }, undefined, { daemon: async () => ({ port: 23456, controlSecret: 'secret' }), fetch: fetcher })).toMatchObject({ state: 'succeeded' })
    expect(fetcher.mock.calls[1][0]).toBe('http://127.0.0.1:12345/call')
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toMatchObject({ sessionId: 'S1', callerGrant: 'opaque-grant' })
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ version: 1, port: -1, secret: 'a'.repeat(43), expiresAt: Date.now() + 30000 })))
    await expect(requestLocalToolAgent(context, {}, undefined, { daemon: async () => ({ port: 23456, controlSecret: 'secret' }), fetch: fetcher })).rejects.toThrow('INVALID_RELAY')
  })
  it('does not authorize Cloud with the machine bearer or injected URLs', async () => {
    vi.stubEnv('HAPPY_APLUS_MCP_CONFIG_URL', 'https://saycode.test/api/me/mcp-config?project_id=P1')
    vi.stubEnv('HAPPY_APLUS_MCP_CALLER_GRANT', '')
    expect(await localToolAgentContext('S1', 'M1')).toBeNull()
    vi.stubEnv('HAPPY_APLUS_MCP_CALLER_GRANT', 'signed-grant')
    expect(await localToolAgentContext('S1', 'M1')).toMatchObject({ serverUrl: 'https://saycode.test', machineId: 'M1', sessionId: 'S1', projectId: 'P1', callerGrant: 'signed-grant' })
    vi.stubEnv('HAPPY_APLUS_MCP_CONFIG_URL', 'https://saycode.test/untrusted')
    expect(await localToolAgentContext('S1', 'M1')).toBeNull()
  })
})
