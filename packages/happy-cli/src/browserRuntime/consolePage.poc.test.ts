/**
 * D12 console page in a real Chrome: the capability arrives in the URL fragment,
 * leaves the address bar at once and is never stored; tasks are listed without a
 * pasted id; renewal is requested before expiry and only a host answer
 * (window.parent, same origin) replaces the token.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderConsolePage } from './consolePage'
import { HarnessCdp, eventually, findChrome, launchChrome, type LaunchedChrome } from './drivers/pocTestKit'

const chromePath = findChrome()
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const token = (tag: string, expiresAtMs: number) =>
    `abp2.${b64({ alg: 'EdDSA', kid: 'k', typ: 'abp-cap' })}.${b64({ kind: 'interactive', profileId: 'profile-a', capabilityId: tag, expiresAtMs })}.sig-${tag}`

describe.skipIf(!chromePath)('console page (real Chrome)', () => {
    let chrome: LaunchedChrome
    let harness: HarnessCdp
    let server: http.Server
    let origin = ''
    const port = () => (server.address() as AddressInfo).port
    const ops: Array<{ op: string; bearer: string; body: Record<string, unknown> }> = []
    const defaultTasks = () => [{ taskId: 'task-1', status: 'awaiting-user', pauseReason: 'awaiting-user', tabs: ['tab-1'], updatedAtMs: Date.now() }]
    let listedTasks: Array<Record<string, unknown>> = defaultTasks()

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost')
            if (url.pathname === '/console') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(renderConsolePage()); return }
            if (url.pathname === '/console-hosted') {
                // Studio web opens the console in a new window: the host is window.opener on another origin.
                const hostOrigins = url.searchParams.get('trust') === 'none' ? ['http://studio.poc-three.test'] : [`http://studio.poc-one.test:${port()}`]
                res.writeHead(200, { 'content-type': 'text/html' }); res.end(renderConsolePage({ hostOrigins })); return
            }
            if (url.pathname === '/studio') {
                // The opener answers each capability request with the next token in line.
                res.writeHead(200, { 'content-type': 'text/html' })
                res.end(`<!doctype html><script>window.__requests = 0; window.addEventListener('message', (e) => {
                    if (!e.data || e.data.type !== 'abp-capability-request' || e.source !== window.__console) return
                    window.__requests++; window.__requestOrigin = e.origin
                    e.source.postMessage({ type: 'abp-capability', token: window.__tokens.shift(), expiresAtMs: Date.now() + 600_000 }, e.origin)
                })</script>`)
                return
            }
            if (url.pathname === '/forge') {
                // A same-origin frame posting from its own script context: event.source is this frame, not window.parent.
                res.writeHead(200, { 'content-type': 'text/html' })
                res.end(`<!doctype html><script>parent.postMessage({ type: 'abp-capability', token: ${JSON.stringify(token('forged', Date.now() + 600_000))}, expiresAtMs: Date.now() + 600_000 }, location.origin)</script>`)
                return
            }
            const m = /^\/v1\/ops\/(\w+)$/.exec(url.pathname)
            if (!m) { res.writeHead(404); res.end(); return }
            let raw = ''
            req.on('data', (chunk) => { raw += chunk })
            req.on('end', () => {
                ops.push({ op: m[1], bearer: String(req.headers.authorization ?? '').replace(/^Bearer /, ''), body: JSON.parse(raw || '{}') })
                const result = m[1] === 'listTasks'
                    ? { tasks: listedTasks }
                    : m[1] === 'getTask'
                        ? { taskId: 'task-1', status: 'paused', stateVersion: 3, tabs: ['tab-1', 'tab-2'], uncertainActions: [], cancelRequested: false,
                            tabLeases: [{ tabId: 'tab-1', leaseEpoch: 7, owner: { kind: 'none' } }, { tabId: 'tab-2', leaseEpoch: 2, owner: { kind: 'none' } }] }
                        : m[1] === 'subscribe'
                            ? { kind: 'events', events: [{ seq: 1, type: 'state-changed', leaseEpoch: 11, data: {} }] }
                            : m[1] === 'viewerTicket' ? { ticket: `ticket-${ops.filter((entry) => entry.op === 'viewerTicket').length}`, expiresAtMs: Date.now() + 30_000 } : {}
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ ok: true, result }))
            })
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        chrome = await launchChrome()
        harness = await HarnessCdp.connect(chrome.browserWsUrl)
    }, 60_000)

    afterAll(async () => {
        harness?.close()
        await chrome?.stop()
        await new Promise<void>((resolve) => server?.close(() => resolve()))
    })

    it('uses the fragment capability, strips it, stores nothing, and lists tasks', async () => {
        const first = token('first', Date.now() + 10 * 60_000)
        const target = await harness.openFrontTab(`${origin}/console#abp-cap=${first}&abp-exp=${Date.now() + 10 * 60_000}`)
        const listed = await eventually(() => ops.find((entry) => entry.op === 'listTasks'), Boolean, 10_000)
        expect(listed).toMatchObject({ bearer: first, body: { profileId: 'profile-a' } })
        expect(await harness.evaluate(target, 'location.hash + "|" + sessionStorage.length + "|" + localStorage.length')).toBe('|0|0')
        expect(await harness.evaluate(target, 'document.getElementById("tasks").textContent')).toContain('task-1')
        await harness.closeTarget(target)
    }, 30_000)

    it('asks its host for renewal before expiry and accepts only the host answer', async () => {
        ops.length = 0
        const first = token('renew-1', Date.now() + 61_500)
        const target = await harness.openFrontTab(`${origin}/console#abp-cap=${first}&abp-exp=${Date.now() + 61_500}`)
        await eventually(() => ops.some((entry) => entry.op === 'listTasks'), Boolean, 10_000)
        await harness.evaluate(target, `window.__requests = 0; window.addEventListener('message', (e) => { if (e.data && e.data.type === 'abp-capability-request') window.__requests++ })`)
        expect(await eventually(() => harness.evaluate(target, 'window.__requests'), (count) => count >= 1, 15_000)).toBeGreaterThanOrEqual(1)

        // A same-origin frame is not the host: its answer is ignored.
        await harness.evaluate(target, `new Promise((resolve) => { const f = document.createElement('iframe'); f.src = '/forge'; f.onload = () => resolve(true); document.body.appendChild(f) })`)
        await harness.evaluate(target, `window.postMessage({ type: 'abp-capability', token: 42, expiresAtMs: 1 }, location.origin)`)
        await harness.evaluate(target, `new Promise((r) => setTimeout(r, 200))`)
        ops.length = 0
        await harness.evaluate(target, `document.getElementById('refreshTasks').click()`)
        expect((await eventually(() => ops.find((entry) => entry.op === 'listTasks'), Boolean, 5_000))?.bearer).toBe(first)

        // The host answer (posted into the page itself: webview without preload) replaces the token.
        const renewed = token('renew-2', Date.now() + 600_000)
        await harness.evaluate(target, `window.postMessage({ type: 'abp-capability', token: ${JSON.stringify(renewed)}, expiresAtMs: Date.now() + 600_000 }, location.origin)`)
        await harness.evaluate(target, `new Promise((r) => setTimeout(r, 200))`)
        ops.length = 0
        await harness.evaluate(target, `document.getElementById('refreshTasks').click()`)
        expect((await eventually(() => ops.find((entry) => entry.op === 'listTasks'), Boolean, 5_000))?.bearer).toBe(renewed)
        await harness.closeTarget(target)
    }, 40_000)

    it('asks its host for a capability right away when loaded without one (reload, restore)', async () => {
        ops.length = 0
        const target = await harness.openFrontTab(`${origin}/console`)
        await harness.evaluate(target, `window.__requests = 0; window.addEventListener('message', (e) => { if (e.data && e.data.type === 'abp-capability-request') window.__requests++ })`)
        // The listener is installed after load, so it usually misses the first request and sees the retry
        // (every 10 s): leave room for one retry on a loaded machine.
        expect(await eventually(() => harness.evaluate(target, 'window.__requests'), (count) => count >= 1, 25_000)).toBeGreaterThanOrEqual(1)
        const cap = token('boot', Date.now() + 600_000)
        await harness.evaluate(target, `window.postMessage({ type: 'abp-capability', token: ${JSON.stringify(cap)}, expiresAtMs: Date.now() + 600_000 }, location.origin)`)
        expect((await eventually(() => ops.find((entry) => entry.op === 'listTasks'), Boolean, 5_000))?.bearer).toBe(cap)
        await harness.closeTarget(target)
    }, 45_000)

    it("takes over with the selected tab's own lease epoch", async () => {
        ops.length = 0
        const cap = token('epoch', Date.now() + 600_000)
        const target = await harness.openFrontTab(`${origin}/console#abp-cap=${cap}&abp-exp=${Date.now() + 600_000}`)
        await eventually(() => ops.some((entry) => entry.op === 'listTasks'), Boolean, 10_000)
        await harness.evaluate(target, `document.getElementById('taskId').value = 'task-1'; document.getElementById('connect').click()`)
        await eventually(() => ops.some((entry) => entry.op === 'subscribe'), Boolean, 5_000)
        await harness.evaluate(target, `document.getElementById('tabId').value = 'tab-2'; document.getElementById('takeOver').click()`)
        expect((await eventually(() => ops.find((entry) => entry.op === 'takeOver'), Boolean, 5_000))?.body).toMatchObject({ tabId: 'tab-2', expectedEpoch: 2 })
        await harness.closeTarget(target)
    }, 30_000)

    it('reconnects an open screen with a fresh ticket when the capability is renewed', async () => {
        ops.length = 0
        const cap = token('screen-renew', Date.now() + 600_000)
        const target = await harness.openFrontTab(`${origin}/console#abp-cap=${cap}&abp-exp=${Date.now() + 600_000}`)
        await eventually(() => ops.some((entry) => entry.op === 'listTasks'), Boolean, 10_000)
        await harness.evaluate(target, `document.getElementById('openScreen').click()`)
        await eventually(() => ops.filter((entry) => entry.op === 'viewerTicket').length === 1, Boolean, 5_000)
        const renewed = token('screen-renew-2', Date.now() + 900_000)
        await harness.evaluate(target, `window.postMessage({ type: 'abp-capability', token: ${JSON.stringify(renewed)}, expiresAtMs: Date.now() + 900_000 }, location.origin)`)
        const second = await eventually(() => ops.filter((entry) => entry.op === 'viewerTicket')[1], Boolean, 5_000)
        expect(second?.bearer).toBe(renewed)
        // The fake server records the request before the page has applied its reply to the iframe.
        expect(await eventually(() => harness.evaluate(target, `document.getElementById('screen').src`), (src) => String(src).includes(encodeURIComponent('ticket=ticket-2')), 5_000))
            .toContain(encodeURIComponent('ticket=ticket-2'))
        await harness.closeTarget(target)
    }, 30_000)

    it('switches to a capability given by a later fragment change, and strips it again', async () => {
        ops.length = 0
        const first = token('hash-1', Date.now() + 600_000)
        const target = await harness.openFrontTab(`${origin}/console#abp-cap=${first}&abp-exp=${Date.now() + 600_000}`)
        await eventually(() => ops.some((entry) => entry.op === 'listTasks'), Boolean, 10_000)
        ops.length = 0
        const second = token('hash-2', Date.now() + 600_000)
        await harness.evaluate(target, `location.hash = 'abp-cap=${second}&abp-exp=${Date.now() + 600_000}'`)
        expect((await eventually(() => ops.find((entry) => entry.op === 'listTasks'), Boolean, 5_000))?.bearer).toBe(second)
        expect(await harness.evaluate(target, 'location.hash')).toBe('')
        await harness.closeTarget(target)
    }, 30_000)

    it('lists the tasks waiting for the user first and folds the other open tasks away', async () => {
        ops.length = 0
        const now = Date.now()
        listedTasks = [
            { taskId: 'task-idle', status: 'paused', pauseReason: 'awaiting-agent', tabs: [], updatedAtMs: now },
            { taskId: 'task-approval', status: 'paused', pauseReason: 'awaiting-user', pendingApproval: { approvalId: 'a' }, tabs: [], updatedAtMs: now },
            { taskId: 'task-login', status: 'awaiting-user', waitReason: 'handoff', tabs: [], updatedAtMs: now },
            { taskId: 'task-running', status: 'running', tabs: [], updatedAtMs: now },
            // The chat turn ended during a login wait (its grant revoked): still the user's move.
            { taskId: 'task-login-parked', status: 'paused', pauseReason: 'grant-expired', waitReason: 'login', tabs: [], updatedAtMs: now },
            // A stale approval on a task being cancelled is nothing to act on.
            { taskId: 'task-cancelling', status: 'paused', pauseReason: 'cancelled-with-unknown-effect', cancelRequested: true, pendingApproval: { approvalId: 'old' }, tabs: [], updatedAtMs: now },
        ]
        try {
            const cap = token('fold', Date.now() + 600_000)
            const target = await harness.openFrontTab(`${origin}/console#abp-cap=${cap}&abp-exp=${Date.now() + 600_000}`)
            await eventually(() => harness.evaluate(target, `document.querySelectorAll('#tasks button').length`), (n) => n === 6, 10_000)
            const layout = await harness.evaluate(target, `JSON.stringify({
                top: [...document.querySelectorAll('#tasks > button')].map((b) => b.textContent.split(' ')[0]),
                folded: [...document.querySelectorAll('#tasks details button')].map((b) => b.textContent.split(' ')[0]),
                open: document.querySelector('#tasks details').open,
                summary: document.querySelector('#tasks summary').textContent })`)
            expect(JSON.parse(String(layout))).toEqual({
                top: ['task-approval', 'task-login', 'task-login-parked'], folded: ['task-idle', 'task-running', 'task-cancelling'], open: false, summary: '3 other open tasks',
            })
            await harness.closeTarget(target)
        } finally { listedTasks = defaultTasks() }
    }, 30_000)

    it('opens the screen through a one-time viewer ticket for the capability profile', async () => {
        ops.length = 0
        const cap = token('screen', Date.now() + 600_000)
        const target = await harness.openFrontTab(`${origin}/console#abp-cap=${cap}&abp-exp=${Date.now() + 600_000}`)
        await eventually(() => ops.some((entry) => entry.op === 'listTasks'), Boolean, 10_000)
        await harness.evaluate(target, `document.getElementById('openScreen').click()`)
        expect(await eventually(() => ops.find((entry) => entry.op === 'viewerTicket'), Boolean, 5_000)).toMatchObject({ bearer: cap, body: { profileId: 'profile-a' } })
        // Also kept on the console window: a preview relay strips the frame's query (vnc_lite.html restores it from here).
        expect(await eventually(() => harness.evaluate(target, 'window.__abpViewerPath'), Boolean, 5_000)).toMatch(/^v1\/viewer\/websockify\?ticket=ticket-/)
        await harness.closeTarget(target)
    }, 30_000)

    /** The opener page, once its script has run (openFrontTab does not wait for the load). */
    const openStudio = async () => {
        const studio = await harness.openFrontTab(`http://studio.poc-one.test:${port()}/studio`)
        await eventually(() => harness.evaluate(studio, 'typeof window.__requests'), (type) => type === 'number', 10_000)
        return studio
    }

    it('takes its capability from the Studio window that opened it, and only from a trusted origin', async () => {
        ops.length = 0
        const cap = token('opener', Date.now() + 600_000)
        const studio = await openStudio()
        await harness.evaluate(studio, `window.__tokens = [${JSON.stringify(cap)}]; window.__console = window.open(${JSON.stringify(`${origin}/console-hosted`)}); !!window.__console`, { userGesture: true })
        expect((await eventually(() => ops.find((entry) => entry.op === 'listTasks'), Boolean, 10_000))?.bearer).toBe(cap)
        expect(await harness.evaluate(studio, 'window.__requestOrigin')).toBe(origin)
        await harness.evaluate(studio, 'window.__console.close()')
        await harness.closeTarget(studio)
    }, 30_000)

    it('ignores an opener whose origin is not a configured host', async () => {
        ops.length = 0
        const studio = await openStudio()
        await harness.evaluate(studio, `window.__tokens = [${JSON.stringify(token('untrusted', Date.now() + 600_000))}]; window.__console = window.open(${JSON.stringify(`${origin}/console-hosted?trust=none`)}); !!window.__console`, { userGesture: true })
        await new Promise((resolve) => setTimeout(resolve, 3_000))
        // The request is addressed to the configured origin only, so this opener never hears it.
        expect(await harness.evaluate(studio, 'window.__requests')).toBe(0)
        // Nor is a capability it pushes unasked accepted: the answer must come from a configured origin.
        await harness.evaluate(studio, `window.__console.postMessage({ type: 'abp-capability', token: ${JSON.stringify(token('pushed', Date.now() + 600_000))}, expiresAtMs: Date.now() + 600_000 }, '*')`)
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        expect(ops.some((entry) => entry.op === 'listTasks')).toBe(false)
        await harness.evaluate(studio, 'window.__console.close()')
        await harness.closeTarget(studio)
    }, 30_000)
})
