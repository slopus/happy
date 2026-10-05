import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { BrowserBridge, deriveBrowserViewerBridgeToken } from './browserBridge'
import { startBrowserBridgeServer } from './browserBridgeServer'
import { startDaemonControlServer } from './controlServer'
import type { PortRegistry } from './portRegistry'

const TOKEN = 'bridge-test-token'

const realFetch = globalThis.fetch

const stubPortRegistry: PortRegistry = {
    allocate: async () => ({ port: 30000, reused: false }),
    release: async () => false,
    readAll: async () => ({}),
}

/** Connect a fake extension and wait for open (or close before open = rejection). */
function connectExtension(port: number, query: string): Promise<{ ws: WebSocket; closedWith?: number }> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/?${query}`)
        ws.on('open', () => resolve({ ws }))
        ws.on('close', (code) => resolve({ ws, closedWith: code }))
        ws.on('error', reject)
    })
}

describe('browserBridgeServer', () => {
    it('admits setup exchange only from the exact installed extension over loopback', async () => {
        const consume: string[] = []
        const server = await startBrowserBridgeServer({ bridge: new BrowserBridge({ authToken: TOKEN }), port: 0,
            consumeSetup: async id => { consume.push(id); return { token: 'scoped-test-token', pairingId: id } },
        })
        const id = 'a'.repeat(32)
        const connect = (origin: string) => new WebSocket(`ws://127.0.0.1:${server.port}/setup-pair?operationId=${id}`, { origin })
        try {
            const bad = connect('https://untrusted.test')
            expect(await new Promise<number>(resolve => bad.on('close', resolve))).toBe(4403)
            expect(consume).toEqual([])
            const good = connect('chrome-extension://emaponnolfbhnoaabgiebjmbdlmoifke')
            const result = await new Promise<string>(resolve => good.on('message', raw => resolve(raw.toString())))
            expect(JSON.parse(result)).toEqual({ ok: true, config: { token: 'scoped-test-token', pairingId: id } })
            expect(consume).toEqual([id])
            good.close()
            const store = connect('chrome-extension://oonefemjapkafdiibkllemkjdlmmblbc')
            expect(JSON.parse(await new Promise<string>(resolve => store.on('message', raw => resolve(raw.toString()))))).toMatchObject({ ok: true })
            store.close()
        } finally { await server.stop() }
    })
    let bridge: BrowserBridge
    let port: number
    let stop: () => Promise<void>

    beforeEach(async () => {
        bridge = new BrowserBridge({ authToken: TOKEN })
        const server = await startBrowserBridgeServer({ bridge, port: 0 })
        port = server.port
        stop = server.stop
    })

    afterEach(async () => {
        await stop()
    })

    it('registers an extension connecting with the right token', async () => {
        const { ws } = await connectExtension(port, `token=${TOKEN}&profile=work`)
        await expect.poll(() => bridge.connections()).toEqual([{ profile: 'work' }])
        ws.close()
    })

    it('forwards a pairing id independently of the profile', async () => {
        const { ws } = await connectExtension(port, `token=${TOKEN}&profile=work&pairingId=viewer-9222`)
        await expect.poll(() => bridge.connections()).toEqual([
            { profile: 'work', pairingId: 'viewer-9222' },
        ])
        ws.close()
    })

    it('closes a connection with a wrong token with code 4401', async () => {
        const { ws } = await connectExtension(port, 'token=wrong')
        const code = await new Promise<number>((resolve) => ws.on('close', resolve))
        expect(code).toBe(4401)
        expect(bridge.connections()).toEqual([])
    })

    it('round-trips a request to the connected extension', async () => {
        const { ws } = await connectExtension(port, `token=${TOKEN}`)
        ws.on('message', (raw) => {
            const message = JSON.parse(raw.toString())
            if (message.method === 'tabs_list') {
                ws.send(JSON.stringify({ id: message.id, result: { tabs: [] } }))
            }
        })
        await expect.poll(() => bridge.connections().length).toBe(1)
        await expect(bridge.request('tabs_list', {})).resolves.toEqual({ tabs: [] })
        ws.close()
    })

    // `new URL(path, 'http://' + host)` throws for a bare IPv6 host ('::1',
    // '::') — brackets are required in a URL authority. The connection
    // handler built its base URL from the bind host, so an IPv6 bind crashed
    // the handler on every incoming connection. Reachable since
    // HAPPY_BROWSER_BRIDGE_HOST made the bind host configurable.
    it('accepts connections when bound to an IPv6 loopback', async () => {
        const v6bridge = new BrowserBridge({ authToken: TOKEN })
        let server
        try {
            server = await startBrowserBridgeServer({ bridge: v6bridge, port: 0, host: '::1' })
        } catch {
            return // machine without IPv6 loopback — nothing to verify here
        }
        try {
            const { ws } = await new Promise<{ ws: WebSocket }>((resolve, reject) => {
                const ws = new WebSocket(`ws://[::1]:${server.port}/?token=${TOKEN}&profile=v6`)
                ws.on('open', () => resolve({ ws }))
                ws.on('error', reject)
            })
            await expect.poll(() => v6bridge.connections()).toEqual([{ profile: 'v6' }])
            ws.close()
        } finally {
            await server.stop()
        }
    })

    it('answers extension pings with pong', async () => {
        const { ws } = await connectExtension(port, `token=${TOKEN}`)
        const pong = new Promise<any>((resolve) => {
            ws.on('message', (raw) => resolve(JSON.parse(raw.toString())))
        })
        ws.send(JSON.stringify({ type: 'ping' }))
        await expect(pong).resolves.toEqual({ type: 'pong' })
        ws.close()
    })
})

describe('controlServer /browser routes', () => {
    let bridge: BrowserBridge
    let bridgePort: number
    let stopBridge: () => Promise<void>
    let baseUrl: string
    let stopControl: () => Promise<void>
    let controlSecret = ''
    // ADR-061: the control server rejects every request without this — every
    // `fetch(...)` call below picks this up lexically (see controlServer.test.ts).
    const fetch = (input: Parameters<typeof realFetch>[0], init?: RequestInit) =>
        realFetch(input, {
            ...init,
            headers: { ...(init?.headers as Record<string, string> | undefined), Authorization: `Bearer ${controlSecret}` },
        })

    beforeEach(async () => {
        bridge = new BrowserBridge({ authToken: TOKEN })
        const bridgeServer = await startBrowserBridgeServer({ bridge, port: 0 })
        bridgePort = bridgeServer.port
        stopBridge = bridgeServer.stop
        const control = await startDaemonControlServer({
            getChildren: () => [],
            stopSession: () => ({ stopped: false, reason: 'not-found' }),
            spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
            requestShutdown: () => {},
            onHappySessionWebhook: () => {},
            portRegistry: stubPortRegistry,
            browserBridge: bridge,
        })
        baseUrl = `http://127.0.0.1:${control.port}`
        stopControl = control.stop
        controlSecret = control.controlSecret
    })

    afterEach(async () => {
        await stopControl()
        await stopBridge()
    })

    it('GET /browser/status reports connected profiles', async () => {
        const before = await fetch(`${baseUrl}/browser/status`)
        expect(await before.json()).toEqual({ connections: [], hasRecentAuthFailure: false })

        const { ws } = await connectExtension(bridgePort, `token=${TOKEN}&profile=work&pairingId=viewer-9222`)
        await expect.poll(() => bridge.connections().length).toBe(1)
        const after = await fetch(`${baseUrl}/browser/status`)
        expect(await after.json()).toEqual({
            connections: [{ profile: 'work', pairingId: 'viewer-9222' }],
            hasRecentAuthFailure: false,
        })
        ws.close()
    })

    it('GET /browser/status returns only the requested viewer boundary', async () => {
        const aliceKey = 'bv1_abcdefghijklmnopqrstuvwxyz012345'
        const bobKey = 'bv1_abcdefghijklmnopqrstuvwxyz012346'
        const alice = await connectExtension(
            bridgePort,
            `token=${deriveBrowserViewerBridgeToken(TOKEN, aliceKey)}&profile=alice&viewerKey=${aliceKey}`,
        )
        const bob = await connectExtension(
            bridgePort,
            `token=${deriveBrowserViewerBridgeToken(TOKEN, bobKey)}&profile=bob&viewerKey=${bobKey}`,
        )
        await expect.poll(() => bridge.connections(aliceKey).length).toBe(1)

        const response = await fetch(`${baseUrl}/browser/status?viewerKey=${aliceKey}`)
        expect(await response.json()).toEqual({
            connections: [{ profile: 'alice', viewerKey: aliceKey }],
            hasRecentAuthFailure: false,
        })
        alice.ws.close()
        bob.ws.close()
    })

    it('POST /browser/request relays to the extension and returns its result', async () => {
        const { ws } = await connectExtension(bridgePort, `token=${TOKEN}`)
        ws.on('message', (raw) => {
            const message = JSON.parse(raw.toString())
            ws.send(JSON.stringify({ id: message.id, result: 'pong' }))
        })
        await expect.poll(() => bridge.connections().length).toBe(1)

        const res = await fetch(`${baseUrl}/browser/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method: 'ping' }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ result: 'pong' })
        ws.close()
    })

    it('POST /browser/request returns 503 when no extension is connected', async () => {
        const res = await fetch(`${baseUrl}/browser/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method: 'ping' }),
        })
        expect(res.status).toBe(503)
        const body = await res.json() as { code: string }
        expect(body.code).toBe('NO_EXTENSION_CONNECTED')
    })

    it('POST /browser/request returns 504 on extension timeout', async () => {
        const { ws } = await connectExtension(bridgePort, `token=${TOKEN}`)
        // extension never answers
        await expect.poll(() => bridge.connections().length).toBe(1)
        const res = await fetch(`${baseUrl}/browser/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method: 'ping', timeoutMs: 100 }),
        })
        expect(res.status).toBe(504)
        const body = await res.json() as { code: string }
        expect(body.code).toBe('TIMEOUT')
        ws.close()
    })
})
