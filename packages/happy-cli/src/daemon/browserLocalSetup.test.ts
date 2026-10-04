import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { BrowserBridge } from './browserBridge'
import { BrowserLocalSetup } from './browserLocalSetup'
import { startDaemonControlServer } from './controlServer'
import { startBrowserBridgeServer } from './browserBridgeServer'
import { WebSocket } from 'ws'

const alice = 'bv1_abcdefghijklmnopqrstuvwxyz012345'
const bob = 'bv1_abcdefghijklmnopqrstuvwxyz012346'
const baseToken = 'local-test-base-token'
class Socket extends EventEmitter {
    closed = false
    send(raw: string) {
        const request = JSON.parse(raw)
        if (request.method === 'tabs_list') queueMicrotask(() => this.emit('message', JSON.stringify({ id: request.id, result: { tabs: [] } })))
    }
    close() { this.closed = true; this.emit('close') }
}
function fixture() {
    const bridge = new BrowserBridge({ authToken: baseToken })
    let now = 1000
    const policies: unknown[] = []
    const setup = new BrowserLocalSetup({
        bridge, readToken: async () => baseToken, port: 41777,
        extension: () => ({ directory: '/test/browser-extension', id: 'emaponnolfbhnoaabgiebjmbdlmoifke', version: '0.1.0' }),
        persistPolicy: async policy => { policies.push(structuredClone(policy)) }, now: () => now,
    })
    return { bridge, setup, policies, expire: () => { now += 300001 } }
}
describe('trusted local browser setup', () => {
    it('authenticates real control HTTP and round-trips a read-only command over the actual websocket bridge', async () => {
        const { setup, bridge } = fixture()
        const listener = await startBrowserBridgeServer({ bridge, port: 0 })
        const control = await startDaemonControlServer({ browserBridge: bridge, browserLocalSetup: setup,
            getChildren: () => [], stopSession: () => ({ status: 'not-found' } as any),
            spawnSession: async () => ({ type: 'error', errorMessage: 'unused' } as any), requestShutdown: () => {}, onHappySessionWebhook: () => {},
            portRegistry: { allocate: async () => ({ port: 30000, reused: false }), release: async () => false, readAll: async () => ({}) },
        })
        const base = `http://127.0.0.1:${control.port}/browser/local-setup`
        const post = (path: string, body: unknown, authenticated = true) => fetch(`${base}/${path}`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${control.controlSecret}` } : {}) }, body: JSON.stringify(body) })
        let ws: WebSocket | undefined
        try {
            expect((await post('begin', { viewerKey: alice, profile: 'My Chrome' }, false)).status).toBe(401)
            const started = await (await post('begin', { viewerKey: alice, profile: 'My Chrome' })).json() as { operationId: string }
            const consumed = await (await post('consume', { operationId: started.operationId })).json() as { config: Record<string, string> }
            ws = new WebSocket(`ws://127.0.0.1:${listener.port}/?${new URLSearchParams(consumed.config)}`)
            ws.on('message', raw => {
                const request = JSON.parse(raw.toString())
                ws!.send(JSON.stringify({ id: request.id, result: { tabs: [{ id: 1 }] } }))
            })
            await new Promise<void>((resolve, reject) => { ws!.on('open', resolve); ws!.on('error', reject) })
            expect(await (await post('status', { viewerKey: alice })).json()).toMatchObject({ state: 'connected', profile: 'My Chrome' })
            expect(await (await post('status', { viewerKey: bob })).json()).toMatchObject({ state: 'idle' })
            const closed = new Promise<number>(resolve => ws!.on('close', resolve))
            expect((await post('revoke', { viewerKey: alice })).ok).toBe(true)
            expect(await closed).toBe(4403)
        } finally { ws?.terminate(); await control.stop(); await listener.stop() }
    })
    it('never exposes credentials in public progress or links, rejects wrong scope and legacy token, and probes the exact connection', async () => {
        const { setup, bridge } = fixture()
        const prepared = await setup.begin(alice, 'My Chrome')
        expect(JSON.stringify(prepared)).not.toMatch(/token|viewerKey/)
        expect(prepared.optionsUrl).toContain('?setup=')
        expect(await setup.status(alice)).toMatchObject({ state: 'waiting' })
        const config = await setup.consume(prepared.operationId)
        expect(config.token).not.toBe(baseToken)
        expect(config.viewerKey).toBe(alice)
        await expect(setup.consume(prepared.operationId)).rejects.toThrow('SETUP_EXPIRED')
        expect(bridge.handleConnection(new Socket(), { ...config, token: baseToken })).toBe(false)
        expect(bridge.handleConnection(new Socket(), { ...config, viewerKey: bob })).toBe(false)
        expect(bridge.handleConnection(new Socket(), { ...config, profile: 'other' })).toBe(false)
        expect(bridge.handleConnection(new Socket(), { ...config, pairingId: 'other' })).toBe(false)
        expect(bridge.handleConnection(new Socket(), config)).toBe(true)
        expect(await setup.status(alice)).toMatchObject({ state: 'connected', profile: 'My Chrome' })
        expect(await setup.status(bob)).toMatchObject({ state: 'idle' })
    })
    it('expires and cancels unconsumed work and preserves revocation across restored bridge policy', async () => {
        const { setup, bridge, policies, expire } = fixture()
        const first = await setup.begin(alice, 'My Chrome')
        expire()
        await expect(setup.consume(first.operationId)).rejects.toThrow('SETUP_EXPIRED')
        const second = await setup.begin(alice, 'My Chrome')
        const config = await setup.consume(second.operationId)
        const socket = new Socket()
        expect(bridge.handleConnection(socket, config)).toBe(true)
        await setup.revoke(alice)
        expect(socket.closed).toBe(true)
        expect(bridge.handleConnection(new Socket(), config)).toBe(false)
        const restored = new BrowserBridge({ authToken: baseToken, setupPolicy: policies.at(-1) as any })
        expect(restored.handleConnection(new Socket(), config)).toBe(false)
        const third = await setup.begin(alice, 'My Chrome')
        expect(bridge.handleConnection(new Socket(), config)).toBe(false)
        await setup.revoke(alice)
        await expect(setup.consume(third.operationId)).rejects.toThrow('SETUP_EXPIRED')
    })
    it('admits a setup pairing only at the daemon that holds its live policy, never via another home or the legacy check', async () => {
        const { setup, bridge } = fixture()
        const config = await setup.consume((await setup.begin(alice, 'My Chrome')).operationId)
        expect(bridge.handleConnection(new Socket(), config)).toBe(true)
        // Another Happy home shares the machine-wide base token but has no policy entry for this pairing.
        const otherHome = new BrowserBridge({ authToken: baseToken })
        expect(otherHome.handleConnection(new Socket(), config)).toBe(false)
        // Dropping the pairing id must not fall back to the plain viewer credential.
        const { pairingId: _dropped, ...withoutPairing } = config
        expect(otherHome.handleConnection(new Socket(), withoutPairing)).toBe(false)
    })
    it('reports a consumed pairing whose Chrome is offline as waiting, not expired', async () => {
        const { setup, bridge, expire } = fixture()
        const config = await setup.consume((await setup.begin(alice, 'My Chrome')).operationId)
        const socket = new Socket()
        expect(bridge.handleConnection(socket, config)).toBe(true)
        socket.close()
        expire()
        expect((await setup.status(alice)).state).toBe('waiting')
    })
    it('fails closed if durable permission cannot be written', async () => {
        const bridge = new BrowserBridge({ authToken: baseToken })
        const setup = new BrowserLocalSetup({ bridge, readToken: async () => baseToken, port: 41777,
            extension: () => ({ directory: '/test', id: 'emaponnolfbhnoaabgiebjmbdlmoifke', version: '0.1.0' }),
            persistPolicy: async () => { throw new Error('disk') },
        })
        await expect(setup.begin(alice, 'My Chrome')).rejects.toThrow('disk')
        expect(await setup.status(alice)).toMatchObject({ state: 'idle' })
    })
})
