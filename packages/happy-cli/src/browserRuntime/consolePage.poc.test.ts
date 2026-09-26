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
    const ops: Array<{ op: string; bearer: string; body: Record<string, unknown> }> = []

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost')
            if (url.pathname === '/console') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(renderConsolePage()); return }
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
                    ? { tasks: [{ taskId: 'task-1', status: 'paused', pauseReason: 'awaiting-user', tabs: ['tab-1'], updatedAtMs: Date.now() }] }
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
        expect(await eventually(() => harness.evaluate(target, 'window.__requests'), (count) => count >= 1, 15_000)).toBeGreaterThanOrEqual(1)
        const cap = token('boot', Date.now() + 600_000)
        await harness.evaluate(target, `window.postMessage({ type: 'abp-capability', token: ${JSON.stringify(cap)}, expiresAtMs: Date.now() + 600_000 }, location.origin)`)
        expect((await eventually(() => ops.find((entry) => entry.op === 'listTasks'), Boolean, 5_000))?.bearer).toBe(cap)
        await harness.closeTarget(target)
    }, 30_000)

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

    it('opens the screen through a one-time viewer ticket for the capability profile', async () => {
        ops.length = 0
        const cap = token('screen', Date.now() + 600_000)
        const target = await harness.openFrontTab(`${origin}/console#abp-cap=${cap}&abp-exp=${Date.now() + 600_000}`)
        await eventually(() => ops.some((entry) => entry.op === 'listTasks'), Boolean, 10_000)
        await harness.evaluate(target, `document.getElementById('openScreen').click()`)
        expect(await eventually(() => ops.find((entry) => entry.op === 'viewerTicket'), Boolean, 5_000)).toMatchObject({ bearer: cap, body: { profileId: 'profile-a' } })
        await harness.closeTarget(target)
    }, 30_000)
})
