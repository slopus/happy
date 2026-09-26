/**
 * CdpDriver against a real local Chrome (headless=new, --site-per-process).
 * Sites: a.poc-one.test (A), b.poc-two.test (B), c.poc-three.test (C), each on
 * its own local port; ledgers are server-side so a click counts only if the
 * page really received a trusted input event.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { BrowserRuntimeError, type BrowserInstanceId, type DispatchExpectation, type ElementDescription, type ElementRef, type Observation, type TabId } from '../contracts'
import { formDigest } from '../policy'
import { CdpDriver } from './cdpDriver'
import { HIT_SCRIPT, HarnessCdp, decodePng, delay, eventually, findChrome, launchChrome, startSite, type LaunchedChrome, type Site } from './pocTestKit'

const chromePath = findChrome()
if (!chromePath) console.warn('[browser-poc] SKIP cdpDriver suite: no Chrome binary (set CHROME_PATH)')

const OPTS = { timeoutMs: 15_000 }

async function expectCode(promise: Promise<unknown>, code: string): Promise<BrowserRuntimeError> {
    try {
        await promise
    } catch (error) {
        expect(error).toBeInstanceOf(BrowserRuntimeError)
        expect((error as BrowserRuntimeError).code).toBe(code)
        return error as BrowserRuntimeError
    }
    throw new Error(`expected ${code}, but the call succeeded`)
}

describe.skipIf(!chromePath)('CdpDriver (real Chrome)', () => {
    let chrome: LaunchedChrome
    let a: Site
    let b: Site
    let c: Site
    let driver: CdpDriver
    let harness: HarnessCdp
    const instanceId = `bi-${randomUUID()}` as BrowserInstanceId
    let bounceCount = () => 0

    beforeAll(async () => {
        chrome = await launchChrome()
        console.info(`[browser-poc] Chrome: ${chrome.version}`)
        ;[a, b, c] = await Promise.all([startSite('a.poc-one.test'), startSite('b.poc-two.test'), startSite('c.poc-three.test')])
        driver = new CdpDriver({ browserWsUrl: chrome.browserWsUrl, browserInstanceIdProvider: async () => instanceId })
        await driver.connect()
        harness = await HarnessCdp.connect(chrome.browserWsUrl)

        a.route('/plain', `<title>Plain A</title><body>Alpha plain page</body>`)
        c.route('/plain', `<title>Plain C</title><body>Charlie page</body>`)
        b.route('/frame', `${HIT_SCRIPT}<body style="margin:0"><p>Bravo frame canary-b-7788</p><button onclick="hit('b-buy')">Buy</button></body>`)
        a.route('/inner', `${HIT_SCRIPT}<body><button onclick="hit('inner')">Inner</button></body>`)
        a.route('/oopif', () => `<title>OOPIF A</title>${HIT_SCRIPT}<body style="margin:0">
            <p>Alpha visible text</p>
            <button onclick="hit('a-buy')">Buy</button>
            <div id="host"></div>
            <script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML = '<button onclick="hit(\\'a-shadow\\')">Shadow Buy</button>'</script>
            <button style="display:none" onclick="hit('a-hidden')">Hidden</button>
            <button disabled onclick="hit('a-disabled')">Disabled</button>
            <label>Password <input type="password" id="pw"></label>
            <script>document.getElementById('pw').value = 'synthetic-pass-canary-123'</script>
            <iframe id="fb" src="${b.url('/frame')}" style="width:400px;height:150px;border:0"></iframe>
        </body>`)
        a.route('/frames', () => `${HIT_SCRIPT}<body><iframe id="same" src="${a.url('/inner')}"></iframe><iframe id="cross" src="${b.url('/frame')}"></iframe></body>`)
        a.route('/spa', `${HIT_SCRIPT}<body style="margin:0"><div id="slot"><button id="pay" style="position:absolute;left:20px;top:20px;width:120px;height:40px" onclick="hit('pay')">Pay</button></div>
            <script>window.swap = () => {
                document.getElementById('pay').remove()
                const d = document.createElement('button')
                d.textContent = 'Pay'
                d.style.cssText = 'position:absolute;left:20px;top:20px;width:120px;height:40px'
                d.onclick = () => hit('decoy')
                document.getElementById('slot').appendChild(d)
            }</script></body>`)
        a.route('/spa-hover', `${HIT_SCRIPT}<body style="margin:0"><div id="slot"><button id="pay" style="position:absolute;left:20px;top:20px;width:120px;height:40px" onclick="hit('pay')">Pay</button></div>
            <script>document.addEventListener('pointermove', () => {
                const old = document.getElementById('pay'); if (!old) return
                old.remove()
                const d = document.createElement('button')
                d.textContent = 'Pay'
                d.style.cssText = 'position:absolute;left:20px;top:20px;width:120px;height:40px'
                d.onclick = () => hit('decoy')
                document.getElementById('slot').appendChild(d)
            }, { once: true })</script></body>`)
        a.route('/pay-form', `${HIT_SCRIPT}<body><form action="/submit-order" onsubmit="event.preventDefault(); hit('submit')"><label>Amount <input name="amount" value="10"></label><label>Secret <input type="password" name="pw" value="synthetic-pw"></label><button id="go">Confirm payment</button></form></body>`)
        a.route('/dialogs', `${HIT_SCRIPT}<body><button onclick="alert('hello'); hit('after-alert')">Alert</button><button onclick="hit(confirm('sure?') ? 'confirmed' : 'declined')">Confirm</button></body>`)
        a.route('/focus-thief', `<body><label>Code <input id="code" onfocus="document.getElementById('other').focus()"></label><label>Other <input id="other"></label></body>`)
        a.route('/slow-load', `<body>slow<script>const until = Date.now() + 4000; while (Date.now() < until) {}</script></body>`)
        a.route('/reload-loop', `<body>reloading<script>setTimeout(() => location.reload(), 150)</script></body>`)
        for (const [name, color] of [['red', '#ff0000'], ['green', '#00ff00'], ['blue', '#0000ff']]) {
            a.route(`/color/${name}`, `<body style="margin:0;background:${color};height:100vh"></body>`)
        }
        a.route('/redirect-to-c', () => ({ status: 302, headers: { location: c.url('/plain') } }))
        a.route('/popup', () => `<body><button onclick="window.open('${c.url('/plain')}', '_blank')">Open C</button><button onclick="window.open('${a.url('/plain')}', '_blank')">Open A</button></body>`)
        a.route('/later', `<body><p>Waiting</p><script>setTimeout(() => { document.body.insertAdjacentHTML('beforeend', '<p>Arrived later</p>'); history.pushState({}, '', '/later/done') }, 400)</script></body>`)
        a.route('/reveal', `${HIT_SCRIPT}<body><button id="r" style="visibility:hidden" onclick="hit('reveal')">Reveal</button><script>setTimeout(() => { document.getElementById('r').style.visibility = 'visible' }, 300)</script></body>`)
        a.route('/form', `${HIT_SCRIPT}<body><input id="name" aria-label="Name" value="old"><button onclick="hit('v-' + encodeURIComponent(document.getElementById('name').value))">Send</button></body>`)
        a.route('/digest-form', `${HIT_SCRIPT}<body><form id="f" action="/order" method="post" onsubmit="event.preventDefault(); hit('digest-submit')">
            <input name="item" value="a"><input name="item" value="b">
            <input type="checkbox" name="gift" value="yes" checked><input type="checkbox" name="wrap" value="yes">
            <select name="size" multiple><option value="s" selected>S</option><option value="m">M</option><option value="l" selected>L</option></select>
            <textarea name="note">hi</textarea><input type="hidden" name="token" value="t1">
            <input name="off" value="ignored" disabled><input type="password" name="pin" value="1234">
            <input name="action" value="clobber">
            <button name="op" value="pay">Pay</button>
            <button name="op" value="alt" formaction="/other" formmethod="get" formenctype="text/plain" type="submit">Alt</button>
            <button type="button" onclick="hit('plain')">Helper</button>
            <a href="/help?x=1">Help link</a>
        </form><button onclick="hit('outside')">Outside</button></body>`)
        a.route('/relabel', `${HIT_SCRIPT}<body style="margin:0"><button id="b" style="position:absolute;left:20px;top:20px;width:160px;height:40px"
            onmouseover="this.textContent = 'Pay now'" onclick="hit('relabel-' + this.textContent)">Continue</button></body>`)
        a.route('/inner-btn', `${HIT_SCRIPT}<body style="margin:0"><button style="position:absolute;left:40px;top:40px;width:120px;height:40px" onclick="hit('inner-btn')">Inner go</button></body>`)
        b.route('/frame-btn', `${HIT_SCRIPT}<body style="margin:0"><button style="position:absolute;left:40px;top:40px;width:120px;height:40px" onclick="hit('frame-btn')">Frame go</button></body>`)
        const framed = (src: string, overlay: boolean) => `${HIT_SCRIPT}<body style="margin:0">
            <iframe src="${src}" style="position:absolute;left:30px;top:30px;width:300px;height:200px;border:5px solid black;padding:3px"></iframe>
            ${overlay ? `<div style="position:absolute;left:0;top:0;width:500px;height:400px;z-index:10;opacity:0.01" onclick="hit('overlay')"></div>` : ''}</body>`
        // The inner button sits at 40..160 x 40..80 of the frame; scaled x2 from the frame's corner (30+5+3=38)
        // it is really at 118..358 x 118..198. The overlay covers only that real area; unscaled maths would
        // check (138, 98) — outside the overlay — and wrongly pass.
        const transformed = (transform: string) => `${HIT_SCRIPT}<body style="margin:0">
            <iframe src="/inner-btn" style="position:absolute;left:30px;top:30px;width:300px;height:200px;border:5px solid black;padding:3px;transform:${transform};transform-origin:0 0"></iframe>
            <div style="position:absolute;left:200px;top:110px;width:200px;height:100px;z-index:10;opacity:0.01" onclick="hit('overlay')"></div></body>`
        a.route('/frame-scaled', transformed('scale(2)'))
        a.route('/frame-rotated', transformed('rotate(3deg)'))
        a.route('/frame-zoomed-parent', `${HIT_SCRIPT}<body style="margin:0"><div style="zoom:2"><iframe src="/inner-btn" style="width:300px;height:200px;border:0"></iframe></div></body>`)
        a.route('/frame-clear-same', framed('/inner-btn', false))
        a.route('/frame-overlay-same', framed('/inner-btn', true))
        a.route('/frame-clear-oopif', () => framed(b.url('/frame-btn'), false))
        a.route('/frame-overlay-oopif', () => framed(b.url('/frame-btn'), true))
        let bounces = 0
        c.route('/bounce', () => { bounces += 1; return { status: 302, headers: { location: a.url('/plain') } } })
        a.route('/via-c', () => ({ status: 302, headers: { location: c.url('/bounce') } }))
        a.route('/redir-hit', () => ({ status: 302, headers: { location: c.url('/hit/redirect') } }))
        bounceCount = () => bounces
        a.route('/exfil', () => `${HIT_SCRIPT}<body>
            <button onclick="window.open('${c.url('/hit/open')}')">Open window</button>
            <button onclick="window.open('${c.url('/hit/noopener')}', '_blank', 'noopener')">Open noopener</button>
            <a href="${c.url('/hit/blank')}" target="_blank">Blank link</a>
            <form action="${c.url('/hit/post')}" method="post"><input name="q" value="synthetic"><button>Post away</button></form>
            <button onclick="fetch('${c.url('/hit/fetch')}', { method: 'POST', mode: 'no-cors', body: 'x' })">Fetch away</button>
            <button onclick="navigator.sendBeacon('${c.url('/hit/beacon')}', 'x')">Beacon away</button>
            <button onclick="window.open('${a.url('/plain')}')">Open allowed</button>
            <button onclick="window.open('${a.url('/hit/over-cap')}')">Open over cap</button>
            <iframe src="${c.url('/hit/frame')}"></iframe></body>`)
        a.route('/meta-refresh', () => `<head><meta http-equiv="refresh" content="1;url=${c.url('/hit/meta')}"></head><body>Refreshing</body>`)
        a.route('/base-target', `${HIT_SCRIPT}<head><base target="_blank"></head><body>
            <form action="/order" method="post"><input name="q" value="1"><button>Order</button></form>
            <a href="/help">Help</a><a href="/self" target="_self">Stay</a>
            <form action="/login"><input type="password" name="pw" value="synthetic-pw"><button>Sign in</button></form>
            <form action="/login2"><input type="password" name="pw"><button>Sign in empty</button></form>
            <form action="/upload" method="post" enctype="multipart/form-data"><input type="file" name="f"><button>Upload</button></form></body>`)
        const guarded = (buttonAttrs: string, script = '') => () => `${HIT_SCRIPT}<body><form id="f" action="/hit/g-post" method="post">
            <input type="hidden" name="token" value="t1"><input name="amount" value="10">
            <button id="pay" name="op" value="pay" style="width:120px;height:40px" ${buttonAttrs}>Pay</button></form>
            <script>const f = document.getElementById('f'), pay = document.getElementById('pay'), token = f.querySelector('[name=token]'); ${script}</script></body>`
        a.route('/guard-plain', guarded(''))
        a.route('/guard-hover-value', guarded(`onmouseover="token.value = 't2'"`))
        a.route('/guard-hover-action', guarded(`onmouseover="pay.setAttribute('formaction', '/hit/g-other')"`))
        a.route('/guard-hover-method', guarded(`onmouseover="f.method = 'get'"`))
        a.route('/guard-hover-target', guarded(`onmouseover="f.target = '_blank'"`))
        a.route('/guard-down', guarded(`onmousedown="token.value = 't2'"`))
        a.route('/guard-click', guarded(`onclick="pay.setAttribute('formaction', '/hit/g-other')"`))
        a.route('/guard-submit-late', guarded('', `f.addEventListener('submit', () => { token.value = 't2' })`))
        a.route('/guard-formdata', guarded('', `f.addEventListener('formdata', (e) => e.formData.set('amount', '999'))`))
        a.route('/descendants', () => `${HIT_SCRIPT}<body>
            <button onclick="window.open('${a.url('/hit/popup-ran')}')">Open popup</button>
            <button onclick="window.open('${a.url('/popup-opener')}')">Open opener popup</button>
            <button onclick="window.worker = new Worker(window.URL.createObjectURL(new Blob(['fetch(\\'${a.url('/hit/worker-ran')}\\', { method: \\'POST\\' })'], { type: 'text/javascript' })))">Start worker</button>
            <button onclick="const f = document.createElement('iframe'); f.src = '${b.url('/frame-runs')}'; document.body.append(f)">Add frame</button></body>`)
        a.route('/popup-opener', () => `<body>popup</body>`)
        b.route('/frame-runs', () => `<body><script>fetch('/hit/frame-ran', { method: 'POST' })</script>frame</body>`)
        const encodings = { get: ['get', 'application/x-www-form-urlencoded'], post: ['post', 'application/x-www-form-urlencoded'],
            multipart: ['post', 'multipart/form-data'], text: ['post', 'text/plain'] } as const
        for (const [key, [method, enctype]] of Object.entries(encodings)) {
            const form = (hit: string, script: string, buttonAttrs = '') => () => `${HIT_SCRIPT}<body><form id="f" action="/hit/${hit}?src=cart" method="${method}" enctype="${enctype}">
                <input type="hidden" name="token" value="t1"><input name="amount" value="10"><textarea name="note">a\nb</textarea>
                <button id="pay" name="op" value="pay" style="width:120px;height:40px" ${buttonAttrs}>Pay</button></form>
                <script>const f = document.getElementById('f'), pay = document.getElementById('pay'); ${script}</script></body>`
            a.route(`/sub-${key}`, form(`sub-${key}`, ''))
            // After every guard listener: an ancestor seeing the bubbling formdata event, and a form listener added mid-click.
            a.route(`/late-bubble-${key}`, form(`late-bubble-${key}`, `document.addEventListener('formdata', (e) => e.formData.set('amount', '999'))`))
            a.route(`/late-form-${key}`, form(`late-form-${key}`, '', `onmousedown="f.addEventListener('formdata', (e) => e.formData.append('extra', '1'))"`))
            // Registered before the guard, in the capture phase: the guard's listeners never see the events.
            const swallow = (type: string, mutate = '') => `window.addEventListener('${type}', (e) => { ${mutate} e.stopImmediatePropagation() }, true)`
            a.route(`/suppress-formdata-${key}`, form(`suppress-formdata-${key}`, swallow('formdata', `e.formData.set('amount', '999');`)))
            a.route(`/suppress-both-${key}`, form(`suppress-both-${key}`, `${swallow('submit')}; ${swallow('formdata', `e.formData.set('amount', '999');`)}`))
            a.route(`/suppress-clean-${key}`, form(`suppress-clean-${key}`, `${swallow('submit')}; ${swallow('formdata')}`))
        }
        a.route('/suppress-file', () => `${HIT_SCRIPT}<body><form id="f" action="/hit/suppress-file" method="post" enctype="multipart/form-data">
            <input name="amount" value="10"><input type="file" name="doc">
            <button id="pay" name="op" value="pay" style="width:120px;height:40px"
                onmousedown="const d = new DataTransfer(); d.items.add(new File(['synthetic'], 'a.txt')); document.querySelector('[name=doc]').files = d.files">Pay</button></form>
            <script>for (const type of ['submit', 'formdata']) window.addEventListener(type, (e) => e.stopImmediatePropagation(), true)</script></body>`)
        a.route('/beforeunload', `${HIT_SCRIPT}<body><script>addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = '' })</script><button onclick="hit('bu')">Touch</button></body>`)
        a.route('/many', `<body>${Array.from({ length: 5 }, (_, i) => `<button>First ${i}</button>`).join('')}
            <section aria-label="Second list">${Array.from({ length: 30 }, (_, i) => `<button>Second ${i}</button>`).join('')}</section></body>`)
    })

    const opened: TabId[] = []
    async function open(path: string, origins: string[]) {
        const tab = await driver.openTab(a.url(path), origins, OPTS)
        opened.push(tab.tabId)
        return tab
    }
    function refOf(obs: Observation, name: string, origin?: string): ElementRef {
        const found = obs.elements.filter((e) => e.name === name && (!origin || e.frameOrigin === origin))
        expect(found, `exactly one element named ${name}`).toHaveLength(1)
        return found[0].ref
    }

    beforeEach(() => {
        for (const site of [a, b, c]) site.resetHits()
    })

    afterEach(async () => {
        for (const tabId of opened.splice(0)) {
            if (driver.hasTab(tabId)) await driver.closeTab(tabId, OPTS).catch(() => undefined)
        }
    })

    afterAll(async () => {
        await driver?.close()
        harness?.close()
        await chrome?.stop()
        await Promise.all([a, b, c].filter(Boolean).map((site) => site.close()))
    })

    describe('explicit target', () => {
        it('opens a background target it owns and reports the browser instance', async () => {
            expect(driver.browserInstanceId()).toBe(instanceId)
            const before = await harness.targets()
            const tab = await driver.openTab(a.url('/plain'), [a.origin], OPTS)
            expect(driver.hasTab(tab.tabId)).toBe(true)
            const after = await harness.targets()
            const created = after.find((t) => t.targetId === tab.targetId)
            expect(created?.type).toBe('page')
            expect(created?.url).toBe(a.url('/plain'))
            expect(before.some((t) => t.targetId === tab.targetId)).toBe(false)
            expect(await driver.currentOrigin(tab.tabId)).toBe(a.origin)
            await driver.closeTab(tab.tabId, OPTS)
        })

        it('rejects a TabId it does not own and never falls back to another tab', async () => {
            await expectCode(driver.observe('tab-unknown' as TabId, [a.origin], OPTS), 'TARGET_GONE')
            await expectCode(driver.click('tab-unknown' as TabId, '@e1' as ElementRef, 'snap' as never, OPTS), 'TARGET_GONE')
            expect(driver.hasTab('tab-unknown' as TabId)).toBe(false)
        })
    })

    describe('agent window cap', () => {
        it('gives each owned tab its own window and refuses a tab beyond maxAgentWindows before creating any target', async () => {
            const capped = new CdpDriver({ browserWsUrl: chrome.browserWsUrl, browserInstanceIdProvider: async () => instanceId, maxAgentWindows: 2 })
            await capped.connect()
            try {
                const first = await capped.openTab(a.url('/plain'), [a.origin], OPTS)
                const second = await capped.openTab(a.url('/plain'), [a.origin], OPTS)
                const windowOf = async (targetId: string) => (await harness.conn.send('Browser.getWindowForTarget', { targetId })).windowId as number
                expect(await windowOf(first.targetId)).not.toBe(await windowOf(second.targetId))
                const before = (await harness.targets()).length
                const refused = await expectCode(capped.openTab(a.url('/plain'), [a.origin], OPTS), 'QUOTA_EXCEEDED')
                expect(refused.mayHaveSideEffects).toBe(false)
                expect((await harness.targets()).length).toBe(before)
                await capped.closeTab(first.tabId, OPTS)
                const third = await capped.openTab(a.url('/plain'), [a.origin], OPTS)
                expect(capped.debugCounts().tabs).toBe(2)
                await capped.closeTab(second.tabId, OPTS)
                await capped.closeTab(third.tabId, OPTS)
            } finally {
                await capped.close()
            }
        })

        it('counts opens that are still in flight, so concurrent opens never exceed the cap', async () => {
            const capped = new CdpDriver({ browserWsUrl: chrome.browserWsUrl, browserInstanceIdProvider: async () => instanceId, maxAgentWindows: 2 })
            await capped.connect()
            try {
                const results = await Promise.allSettled([0, 1, 2, 3].map(() => capped.openTab(a.url('/plain'), [a.origin], OPTS)))
                const opened = results.filter((r) => r.status === 'fulfilled')
                const refused = results.filter((r) => r.status === 'rejected' && (r.reason as BrowserRuntimeError).code === 'QUOTA_EXCEEDED')
                expect(opened).toHaveLength(2)
                expect(refused).toHaveLength(2)
                for (const r of opened) await capped.closeTab((r as PromiseFulfilledResult<{ tabId: TabId }>).value.tabId, OPTS)
                // A failed open releases its slot too.
                await expectCode(capped.openTab('http://unlisted.invalid/', [a.origin], OPTS), 'ORIGIN_DENIED')
                const again = await Promise.all([0, 1].map(() => capped.openTab(a.url('/plain'), [a.origin], OPTS)))
                for (const tab of again) await capped.closeTab(tab.tabId, OPTS)
            } finally {
                await capped.close()
            }
        })
    })

    describe('window reservations', () => {
        const cappedDriver = async (maxAgentWindows: number, testHooks?: ConstructorParameters<typeof CdpDriver>[0]['testHooks']) => {
            const capped = new CdpDriver({ browserWsUrl: chrome.browserWsUrl, browserInstanceIdProvider: async () => instanceId, maxAgentWindows, testHooks })
            await capped.connect()
            return capped
        }

        it('counts a registered tab once while its page is still loading, so a staggered second open fits', async () => {
            const capped = await cappedDriver(2)
            try {
                const slow = capped.openTab(a.url('/slow-load'), [a.origin], { timeoutMs: 20_000 })
                await eventually(() => capped.debugCounts().tabs, (n) => n === 1)
                const second = await capped.openTab(a.url('/plain'), [a.origin], OPTS)
                await expectCode(capped.openTab(a.url('/plain'), [a.origin], OPTS), 'QUOTA_EXCEEDED')
                const first = await slow
                expect(capped.debugCounts().windows).toBe(2)
                await capped.closeTab(first.tabId, OPTS)
                await capped.closeTab(second.tabId, OPTS)
                expect(capped.debugCounts().windows).toBe(0)
            } finally {
                await capped.close()
            }
        })

        it('keeps a window reserved until its target is confirmed gone, even when cleanup failed', async () => {
            let closeFails = true
            const capped = await cappedDriver(1, { discardCloseFails: () => closeFails })
            try {
                await expectCode(capped.openTab(a.url('/slow-load'), [a.origin], { timeoutMs: 1_000 }), 'OUTCOME_UNKNOWN')
                // The discarded tab is forgotten, but its window was never confirmed gone.
                await eventually(() => capped.debugCounts().tabs, (n) => n === 0, 10_000)
                expect(capped.debugCounts().windows).toBe(1)
                await expectCode(capped.openTab(a.url('/plain'), [a.origin], OPTS), 'QUOTA_EXCEEDED')
                closeFails = false
                const leftover = (await harness.targets()).filter((t) => t.url.includes('/slow-load'))
                for (const target of leftover) await harness.closeTarget(target.targetId)
                await eventually(() => capped.debugCounts().windows, (n) => n === 0)
                const tab = await capped.openTab(a.url('/plain'), [a.origin], OPTS)
                await capped.closeTab(tab.tabId, OPTS)
            } finally {
                await capped.close()
            }
        })

        it('counts popups of owned tabs and closes one that would exceed the cap before it loads', async () => {
            // Its own browser: a second driver on the same browser would release the paused popup.
            const own = await launchChrome()
            const capped = new CdpDriver({ browserWsUrl: own.browserWsUrl, browserInstanceIdProvider: async () => instanceId, maxAgentWindows: 2 })
            await capped.connect()
            const ownHarness = await HarnessCdp.connect(own.browserWsUrl)
            try {
                const tab = await capped.openTab(a.url('/exfil'), [a.origin], OPTS)
                const obs = await capped.observe(tab.tabId, [a.origin], OPTS)
                const press = (name: string) => capped.click(tab.tabId, obs.elements.find((e) => e.name === name)!.ref, obs.snapshotId, OPTS)
                await press('Open allowed')
                await eventually(() => capped.debugCounts().windows, (n) => n === 2)
                await expectCode(capped.openTab(a.url('/plain'), [a.origin], OPTS), 'QUOTA_EXCEEDED')
                await press('Open over cap')
                await delay(800)
                expect(a.hits('over-cap')).toBe(0)
                expect(capped.debugCounts().windows).toBe(2)
                const popup = capped.popupReports().find((p) => p.origin === a.origin && !p.closed)!
                await ownHarness.closeTarget(popup.targetId)
                await eventually(() => capped.debugCounts().windows, (n) => n === 1)
                await capped.closeTab(tab.tabId, OPTS)
            } finally {
                await capped.close()
                ownHarness.close()
                await own.stop()
            }
        })
    })

    describe('interception failure fails closed', () => {
        // Its own browser: another driver attached to the same browser would release paused popups.
        type Kind = 'popup' | 'worker' | 'iframe'
        async function withFailingGuard(fail: (kind: Kind, method: string, depth: number) => boolean, body: (d: CdpDriver, own: HarnessCdp) => Promise<void>) {
            const own = await launchChrome()
            const failing = new CdpDriver({ browserWsUrl: own.browserWsUrl, browserInstanceIdProvider: async () => instanceId, testHooks: { guardFailure: fail } })
            await failing.connect()
            const ownHarness = await HarnessCdp.connect(own.browserWsUrl)
            try {
                await body(failing, ownHarness)
            } finally {
                await failing.close()
                ownHarness.close()
                await own.stop()
            }
        }
        async function press(d: CdpDriver, tabId: TabId, name: string) {
            const obs = await d.observe(tabId, [a.origin, b.origin], OPTS)
            return d.click(tabId, obs.elements.find((e) => e.name === name)!.ref, obs.snapshotId, OPTS)
        }

        it('control: with interception working, the popup, worker and frame do run', async () => {
            await withFailingGuard(() => false, async (d, own) => {
                const tab = await d.openTab(a.url('/descendants'), [a.origin, b.origin], OPTS)
                for (const name of ['Open popup', 'Start worker', 'Add frame', 'Open opener popup']) await press(d, tab.tabId, name)
                const child = await eventually(() => own.targets(), (t) => t.some((x) => x.url.endsWith('/popup-opener')))
                const { sessionId } = await own.conn.send('Target.attachToTarget', { targetId: child.find((x) => x.url.endsWith('/popup-opener'))!.targetId, flatten: true })
                void own.conn.send('Runtime.evaluate', { expression: `window.open('${a.url('/hit/grandchild-ran')}'); 1`, userGesture: true }, sessionId).catch(() => undefined)
                const ran = () => ({ popup: a.hits('popup-ran'), worker: a.hits('worker-ran'), frame: b.hits('frame-ran'), grandchild: a.hits('grandchild-ran') })
                expect(await eventually(ran, (r) => Object.values(r).every((n) => n === 1), 15_000)).toEqual({ popup: 1, worker: 1, frame: 1, grandchild: 1 })
                for (const site of [a, b]) site.resetHits()
            })
        })

        for (const method of ['Fetch.enable', 'Target.setAutoAttach']) {
            it(`closes a popup whose ${method} failed before it runs, and refuses further work on the tab`, async () => {
                await withFailingGuard((kind, failed) => kind === 'popup' && failed === method, async (d, own) => {
                    const tab = await d.openTab(a.url('/descendants'), [a.origin, b.origin], OPTS)
                    await press(d, tab.tabId, 'Open popup').catch(() => undefined)
                    await delay(1_000)
                    expect(a.hits('popup-ran')).toBe(0)
                    expect((await own.targets()).some((t) => t.url.includes('/hit/popup-ran'))).toBe(false)
                    const refused = await expectCode(d.observe(tab.tabId, [a.origin], OPTS), 'RUNTIME_UNAVAILABLE')
                    expect(refused.message).toContain('interception')
                    expect(await d.closeTab(tab.tabId, OPTS)).toEqual({ closed: true })
                })
            })
        }

        it('keeps a worker whose interception failed paused (it never runs)', async () => {
            await withFailingGuard((kind) => kind === 'worker', async (d) => {
                const tab = await d.openTab(a.url('/descendants'), [a.origin, b.origin], OPTS)
                await press(d, tab.tabId, 'Start worker').catch(() => undefined)
                await delay(1_000)
                expect(a.hits('worker-ran')).toBe(0)
                await expectCode(d.observe(tab.tabId, [a.origin], OPTS), 'RUNTIME_UNAVAILABLE')
            })
        })

        it('keeps a cross-site frame whose interception failed paused (its script never runs)', async () => {
            await withFailingGuard((kind) => kind === 'iframe', async (d) => {
                const tab = await d.openTab(a.url('/descendants'), [a.origin, b.origin], OPTS)
                await press(d, tab.tabId, 'Add frame').catch(() => undefined)
                await delay(1_000)
                expect(b.hits('frame-ran')).toBe(0)
                await expectCode(d.observe(tab.tabId, [a.origin], OPTS), 'RUNTIME_UNAVAILABLE')
            })
        })

        it('closes a popup opened by a popup (descendant) whose interception failed', async () => {
            await withFailingGuard((kind, method, depth) => kind === 'popup' && depth >= 2 && method === 'Fetch.enable', async (d, own) => {
                const tab = await d.openTab(a.url('/descendants'), [a.origin, b.origin], OPTS)
                await press(d, tab.tabId, 'Open opener popup')
                const child = await eventually(() => own.targets(), (t) => t.some((x) => x.url.endsWith('/popup-opener')))
                const { sessionId } = await own.conn.send('Target.attachToTarget', { targetId: child.find((x) => x.url.endsWith('/popup-opener'))!.targetId, flatten: true })
                // A user gesture inside the (allowed, guarded) popup opens its own popup.
                void own.conn.send('Runtime.evaluate', { expression: `window.open('${a.url('/hit/grandchild-ran')}'); 1`, userGesture: true }, sessionId).catch(() => undefined)
                await delay(1_500)
                expect(a.hits('grandchild-ran')).toBe(0)
                await expectCode(d.observe(tab.tabId, [a.origin], OPTS), 'RUNTIME_UNAVAILABLE')
            })
        })
    })

    describe('OOPIF and snapshot', () => {
        it('attaches the cross-site iframe as a separate child target and observes both frames', async () => {
            const tab = await open('/oopif', [a.origin, b.origin])
            const targets = await harness.targets()
            const child = targets.find((t) => t.type === 'iframe' && t.url === b.url('/frame'))
            expect(child, 'real OOPIF child target').toBeDefined()
            console.info(`[browser-poc] OOPIF child target observed: ${!!child}`)

            const obs = await driver.observe(tab.tabId, [a.origin, b.origin], OPTS)
            const frameB = obs.frames.find((f) => f.origin === b.origin)
            expect(frameB).toMatchObject({ allowed: true, outOfProcess: true })
            expect(frameB?.text).toContain('Bravo frame')
            expect(obs.frames[0]).toMatchObject({ origin: a.origin, allowed: true, outOfProcess: false })
            const buyA = refOf(obs, 'Buy', a.origin)
            const buyB = refOf(obs, 'Buy', b.origin)
            expect(buyA).not.toBe(buyB)
            expect(buyB).toMatch(/^@f\d+:e\d+$/)
            expect(obs.elements.find((e) => e.name === 'Shadow Buy')).toBeDefined()
            expect(obs.elements.find((e) => e.name === 'Hidden')).toMatchObject({ visible: false })
            expect(obs.elements.find((e) => e.name === 'Disabled')).toMatchObject({ disabled: true })
            const password = obs.elements.find((e) => e.name === 'Password')
            expect(password).toBeDefined()
            expect(password?.value).toBeUndefined()
            expect(JSON.stringify(obs)).not.toContain('synthetic-pass-canary')
        })

        it('returns no text or refs from a frame whose origin is not allowed', async () => {
            const tab = await open('/oopif', [a.origin])
            const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            // The disallowed frame's document request is stopped unsent: it is reported, not loaded.
            const frameB = obs.frames.find((f) => f.origin !== a.origin)
            expect(frameB).toMatchObject({ allowed: false })
            expect(driver.blockedReports().some((r) => r.tabId === tab.tabId && r.origin === b.origin && r.resourceType === 'Document')).toBe(true)
            expect(frameB?.text).toBeUndefined()
            expect(obs.elements.every((e) => e.frameOrigin === a.origin)).toBe(true)
            const serialized = JSON.stringify(obs)
            expect(serialized).not.toContain('canary-b-7788')
            expect(serialized).not.toContain('Bravo')
        })

        it('truncates at the element budget and can observe a subtree via scopeRef', async () => {
            const tab = await open('/many', [a.origin])
            const obs = await driver.observe(tab.tabId, [a.origin], { ...OPTS, maxElements: 8 })
            expect(obs.truncated).toBe(true)
            expect(obs.elements).toHaveLength(8)
            const section = refOf(obs, 'Second list')
            const scoped = await driver.observe(tab.tabId, [a.origin], { ...OPTS, scopeRef: section, maxElements: 100 })
            expect(scoped.truncated).toBe(false)
            expect(scoped.elements).toHaveLength(30)
            expect(scoped.elements.every((e) => e.name.startsWith('Second '))).toBe(true)
        })
    })

    describe('trusted input', () => {
        it('clicks only the addressed frame when two frames have a same-label button', async () => {
            const tab = await open('/oopif', [a.origin, b.origin])
            const obs = await driver.observe(tab.tabId, [a.origin, b.origin], OPTS)
            await driver.click(tab.tabId, refOf(obs, 'Buy', b.origin), obs.snapshotId, OPTS)
            expect(await eventually(() => b.hits('b-buy'), (n) => n === 1)).toBe(1)
            await driver.click(tab.tabId, refOf(obs, 'Buy', a.origin), obs.snapshotId, OPTS)
            expect(await eventually(() => a.hits('a-buy'), (n) => n === 1)).toBe(1)
            await driver.click(tab.tabId, refOf(obs, 'Shadow Buy'), obs.snapshotId, OPTS)
            expect(await eventually(() => a.hits('a-shadow'), (n) => n === 1)).toBe(1)
            await delay(200)
            expect(b.hits('b-buy')).toBe(1)
            expect(a.hits('a-buy')).toBe(1)
        })

        it('refuses hidden and disabled elements without dispatching', async () => {
            const tab = await open('/oopif', [a.origin, b.origin])
            const obs = await driver.observe(tab.tabId, [a.origin, b.origin], OPTS)
            await expectCode(driver.click(tab.tabId, refOf(obs, 'Hidden'), obs.snapshotId, OPTS), 'INVALID_REQUEST')
            await expectCode(driver.click(tab.tabId, refOf(obs, 'Disabled'), obs.snapshotId, OPTS), 'INVALID_REQUEST')
            await delay(200)
            expect(a.hits('a-hidden')).toBe(0)
            expect(a.hits('a-disabled')).toBe(0)
        })

        it('fills a text field with trusted input, replacing its value', async () => {
            const tab = await open('/form', [a.origin])
            const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            await driver.fill(tab.tabId, refOf(obs, 'Name'), obs.snapshotId, 'Neo', OPTS)
            await driver.click(tab.tabId, refOf(obs, 'Send'), obs.snapshotId, OPTS)
            expect(await eventually(() => a.hits('v-Neo'), (n) => n === 1)).toBe(1)
            expect(a.hits('v-old')).toBe(0)
        })
    })

    describe('closeTab during a reload', () => {
        it('closes a tab that is reloading itself (20x) and leaves no registrations', async () => {
            const before = driver.debugCounts()
            for (let i = 0; i < 20; i++) {
                const tab = await driver.openTab(a.url('/reload-loop'), [a.origin], OPTS)
                await delay(100 + (i % 5) * 20)
                expect(await driver.closeTab(tab.tabId, OPTS)).toEqual({ closed: true })
            }
            expect(driver.debugCounts()).toEqual(before)
        })
    })

    describe('openTab timeout', () => {
        it('discards the half-opened target when the caller already gave up (no leaked owned tab)', async () => {
            const before = driver.debugCounts()
            await expectCode(driver.openTab(a.url('/slow-load'), [a.origin], { timeoutMs: 1_000 }), 'OUTCOME_UNKNOWN')
            // Even after the page finally loads, nothing is left registered.
            await delay(5_000)
            expect(driver.debugCounts()).toEqual(before)
        })
    })

    describe('fill focus', () => {
        it('refuses to type when the page moves focus away from the target', async () => {
            const tab = await open('/focus-thief', [a.origin])
            const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            const error = await expectCode(driver.fill(tab.tabId, refOf(obs, 'Code'), obs.snapshotId, 'secret-otp', OPTS), 'INVALID_REQUEST')
            expect(error.mayHaveSideEffects).toBe(false)
            expect(await harness.evaluate(tab.targetId, "document.getElementById('other').value")).toBe('')
        })
    })

    describe('javascript dialogs', () => {
        it('dismisses alert/confirm opened by an agent click instead of freezing the tab, and never accepts on the user\'s behalf', async () => {
            const tab = await open('/dialogs', [a.origin])
            let obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            await driver.click(tab.tabId, refOf(obs, 'Alert'), obs.snapshotId, { timeoutMs: 5_000 })
            expect(await eventually(() => a.hits('after-alert'), (n) => n === 1)).toBe(1)
            obs = await driver.observe(tab.tabId, [a.origin], { timeoutMs: 5_000 })
            await driver.click(tab.tabId, refOf(obs, 'Confirm'), obs.snapshotId, { timeoutMs: 5_000 })
            expect(await eventually(() => a.hits('declined'), (n) => n === 1)).toBe(1)
            expect(a.hits('confirmed')).toBe(0)
            expect(driver.dialogReports().filter((report) => report.tabId === tab.tabId).map((report) => report.type)).toEqual(['alert', 'confirm'])
        })
    })

    describe('describeRef', () => {
        it('describes the element of the agent snapshot with live form values, without superseding that snapshot', async () => {
            const tab = await open('/pay-form', [a.origin])
            const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            const confirm = refOf(obs, 'Confirm payment')
            await harness.evaluate(tab.targetId, "document.querySelector('[name=amount]').value = '999'")
            const described = await driver.describeRef(tab.tabId, confirm, obs.snapshotId, OPTS)
            expect(described).toMatchObject({ name: 'Confirm payment', frameOrigin: a.origin, formValues: { amount: '999' } })
            expect(described.formAction).toBe(a.url('/submit-order'))
            expect(described.formValues).not.toHaveProperty('pw')
            // The agent's snapshot is still the current one: its ref can be clicked.
            await driver.click(tab.tabId, confirm, obs.snapshotId, OPTS)
            expect(await eventually(() => a.hits('submit'), (n) => n === 1)).toBe(1)
        })

        it('restores a ref from its persisted identity on a new driver (Runtime-only restart) only while the document is unchanged', async () => {
            const tab = await open('/pay-form', [a.origin])
            const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            const confirm = refOf(obs, 'Confirm payment')
            const described = await driver.describeRef(tab.tabId, confirm, obs.snapshotId, OPTS)
            expect(Buffer.from(described.identity, 'base64url').toString()).not.toContain('Confirm payment')
            const restarted = new CdpDriver({ browserWsUrl: chrome.browserWsUrl, browserInstanceIdProvider: async () => instanceId })
            try {
                await restarted.connect()
                expect(await restarted.adoptTab(tab.tabId, tab.targetId, [a.origin], OPTS)).toBe(true)
                expect(await restarted.restoreRef(tab.tabId, obs.snapshotId, confirm, described.identity, OPTS)).toBe('restored')
                const again = await restarted.describeRef(tab.tabId, confirm, obs.snapshotId, OPTS)
                expect(again.documentGeneration).toBe(described.documentGeneration)
                expect(again.formValues).toEqual(described.formValues)
                // A reload is a new document: the persisted identity no longer binds.
                await harness.evaluate(tab.targetId, 'location.reload()')
                await delay(1_000)
                const fresh = new CdpDriver({ browserWsUrl: chrome.browserWsUrl, browserInstanceIdProvider: async () => instanceId })
                await fresh.connect()
                try {
                    expect(await fresh.adoptTab(tab.tabId, tab.targetId, [a.origin], OPTS)).toBe(true)
                    expect(await fresh.restoreRef(tab.tabId, obs.snapshotId, confirm, described.identity, OPTS)).toBe('gone')
                } finally {
                    await fresh.close()
                }
            } finally {
                await restarted.close()
                await driver.closeTab(tab.tabId, OPTS)
            }
        })

        it('describes the full ordered form submission with submitter overrides and a digest that tracks every change', async () => {
            const tab = await open('/digest-form', [a.origin])
            const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            const pay = await driver.describeRef(tab.tabId, refOf(obs, 'Pay'), obs.snapshotId, OPTS)
            expect(pay.submitsForm).toBe(true)
            expect(pay.form).toMatchObject({
                // A filled password cannot be bound: the form is opaque (the runtime hands it to the user).
                action: a.url('/order'), method: 'post', enctype: 'application/x-www-form-urlencoded', target: '', opaque: true,
                fields: [['item', 'a'], ['item', 'b'], ['gift', 'yes'], ['size', 's'], ['size', 'l'], ['note', 'hi'], ['token', 't1'],
                    ['pin', { password: 4 }], ['action', 'clobber'], ['op', 'pay']],
                submitter: { name: 'op', value: 'pay', formaction: null, formmethod: null, formenctype: null },
            })
            expect(pay.form!.digest).toBe(formDigest(pay.form!))
            expect(JSON.stringify(pay)).not.toContain('1234')
            const alt = await driver.describeRef(tab.tabId, refOf(obs, 'Alt'), obs.snapshotId, OPTS)
            expect(alt.form).toMatchObject({ action: a.url('/other'), method: 'get', enctype: 'text/plain',
                submitter: { name: 'op', value: 'alt', formaction: '/other', formmethod: 'get', formenctype: 'text/plain' } })
            expect(alt.form!.fields.at(-1)).toEqual(['op', 'alt'])
            expect(alt.form!.digest).not.toBe(pay.form!.digest)
            const helper = await driver.describeRef(tab.tabId, refOf(obs, 'Helper'), obs.snapshotId, OPTS)
            expect(helper).toMatchObject({ submitsForm: false, form: { submitter: null } })
            expect(helper.form!.fields.map(([name]) => name)).not.toContain('op')
            const link = await driver.describeRef(tab.tabId, refOf(obs, 'Help link'), obs.snapshotId, OPTS)
            expect(link).toMatchObject({ linkUrl: a.url('/help?x=1'), currentRole: 'link', currentName: 'Help link' })
            const outside = await driver.describeRef(tab.tabId, refOf(obs, 'Outside'), obs.snapshotId, OPTS)
            expect(outside.form).toBeUndefined()
            // Any change to what would be sent changes the digest: a hidden value, the order, the password.
            for (const mutate of [
                "document.querySelector('[name=token]').value = 't2'",
                "document.getElementById('f').prepend(document.querySelector('[name=note]'))",
                "document.querySelector('[name=pin]').value = '12345'",
                "document.getElementById('f').setAttribute('action', '/elsewhere')",
            ]) {
                const before = (await driver.describeRef(tab.tabId, refOf(obs, 'Pay'), obs.snapshotId, OPTS)).form!.digest
                await harness.evaluate(tab.targetId, mutate)
                const after = await driver.describeRef(tab.tabId, refOf(obs, 'Pay'), obs.snapshotId, OPTS)
                expect(after.form!.digest, mutate).not.toBe(before)
            }
            expect(a.hits('digest-submit')).toBe(0)
        })

        it('reports effective targets including <base target>, and marks forms whose submitted content cannot be bound', async () => {
            const tab = await open('/base-target', [a.origin])
            const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            const describe = (name: string) => driver.describeRef(tab.tabId, refOf(obs, name), obs.snapshotId, OPTS)
            expect((await describe('Order')).form).toMatchObject({ target: '_blank', opaque: false })
            expect(await describe('Help')).toMatchObject({ linkUrl: a.url('/help'), linkTarget: '_blank' })
            expect(await describe('Stay')).toMatchObject({ linkTarget: '_self' })
            expect((await describe('Sign in')).form?.opaque).toBe(true)
            expect((await describe('Sign in empty')).form?.opaque).toBe(false)
            expect((await describe('Upload')).form?.opaque).toBe(false)
            // A chosen file's content cannot be bound either.
            await harness.evaluate(tab.targetId, `(() => { const input = document.querySelector('[name=f]'); const data = new DataTransfer(); data.items.add(new File(['synthetic'], 'a.txt')); input.files = data.files; return 1 })()`)
            expect((await describe('Upload')).form?.opaque).toBe(true)
        })

        it('fails with STALE_REF when the node behind the ref was replaced', async () => {
            const tab = await open('/spa', [a.origin])
            const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            await harness.evaluate(tab.targetId, 'swap()')
            await expectCode(driver.describeRef(tab.tabId, refOf(obs, 'Pay'), obs.snapshotId, OPTS), 'STALE_REF')
        })
    })

    describe('dispatch-time label and ancestor overlay checks', () => {
        it('refuses to click when the same node was relabelled after the snapshot (no dispatch)', async () => {
            const tab = await open('/relabel', [a.origin])
            const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            const error = await expectCode(driver.click(tab.tabId, refOf(obs, 'Continue'), obs.snapshotId, OPTS), 'STALE_REF')
            expect(error.mayHaveSideEffects).toBe(false)
            await delay(300)
            expect(a.hits('relabel-Pay now') + a.hits('relabel-Continue')).toBe(0)
        })

        it('clicks inside a same-process iframe and an OOPIF when nothing in a parent document covers them', async () => {
            let tab = await open('/frame-clear-same', [a.origin])
            let obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            await driver.click(tab.tabId, refOf(obs, 'Inner go'), obs.snapshotId, OPTS)
            expect(await eventually(() => a.hits('inner-btn'), (n) => n === 1)).toBe(1)
            tab = await open('/frame-clear-oopif', [a.origin, b.origin])
            obs = await driver.observe(tab.tabId, [a.origin, b.origin], OPTS)
            await driver.click(tab.tabId, refOf(obs, 'Frame go'), obs.snapshotId, OPTS)
            expect(await eventually(() => b.hits('frame-btn'), (n) => n === 1)).toBe(1)
        })

        it('hands off a click in a transformed or zoomed frame instead of trusting untransformed geometry (no dispatch)', async () => {
            for (const path of ['/frame-scaled', '/frame-rotated', '/frame-zoomed-parent']) {
                const tab = await open(path, [a.origin])
                const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
                const error = await expectCode(driver.click(tab.tabId, refOf(obs, 'Inner go'), obs.snapshotId, OPTS), 'APPROVAL_REQUIRED')
                expect(error.mayHaveSideEffects, path).toBe(false)
                await delay(300)
                expect(a.hits('inner-btn'), path).toBe(0)
                expect(a.hits('overlay'), path).toBe(0)
            }
        })

        it('refuses a click whose iframe is covered by an element of the parent document (same-process and OOPIF)', async () => {
            for (const [path, name, site, hit] of [['/frame-overlay-same', 'Inner go', a, 'inner-btn'], ['/frame-overlay-oopif', 'Frame go', b, 'frame-btn']] as const) {
                const tab = await open(path, [a.origin, b.origin])
                const obs = await driver.observe(tab.tabId, [a.origin, b.origin], OPTS)
                const error = await expectCode(driver.click(tab.tabId, refOf(obs, name), obs.snapshotId, OPTS), 'INVALID_REQUEST')
                expect(error.mayHaveSideEffects, path).toBe(false)
                expect(error.message, path).toContain('covered by a parent document')
                await delay(300)
                expect(site.hits(hit), path).toBe(0)
                expect(a.hits('overlay'), path).toBe(0)
            }
        })
    })

    describe('dispatch-time binding and submission guard', () => {
        const expectationOf = (d: ElementDescription): DispatchExpectation => ({ role: d.currentRole ?? d.role, name: d.currentName ?? d.name,
            ...(d.linkUrl ? { linkUrl: d.linkUrl, linkTarget: d.linkTarget ?? '' } : {}), ...(d.form ? { formDigest: d.form.digest } : {}) })
        async function clickExpecting(path: string) {
            const tab = await open(path, [a.origin])
            const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            const ref = refOf(obs, 'Pay')
            const expectation = expectationOf(await driver.describeRef(tab.tabId, ref, obs.snapshotId, OPTS))
            return driver.click(tab.tabId, ref, obs.snapshotId, { ...OPTS, expect: expectation })
        }

        it('submits exactly the described form when nothing changed', async () => {
            await clickExpecting('/guard-plain')
            expect(await eventually(() => a.hits('g-post'), (n) => n === 1)).toBe(1)
        })

        it('refuses before pressing when hovering changed a value, formaction, method or target (no dispatch)', async () => {
            for (const path of ['/guard-hover-value', '/guard-hover-action', '/guard-hover-method', '/guard-hover-target']) {
                const error = await expectCode(clickExpecting(path), 'STALE_REF')
                expect(error.mayHaveSideEffects, path).toBe(false)
            }
            await delay(500)
            expect(a.hits('g-post') + a.hits('g-other')).toBe(0)
        })

        for (const key of ['get', 'post', 'multipart', 'text']) {
            it(`checks the final ${key} request: an unchanged one is sent once, one changed by a late formdata listener is not sent`, async () => {
                await clickExpecting(`/sub-${key}`)
                expect(await eventually(() => a.hits(`sub-${key}`), (n) => n === 1)).toBe(1)
                for (const late of [`late-bubble-${key}`, `late-form-${key}`]) {
                    const error = await expectCode(clickExpecting(`/${late}`), 'APPROVAL_EXPIRED')
                    expect(error.mayHaveSideEffects, late).toBe(true)
                }
                await delay(800)
                expect(a.hits(`late-bubble-${key}`) + a.hits(`late-form-${key}`)).toBe(0)
            })
        }

        for (const key of ['get', 'post', 'multipart', 'text']) {
            it(`verifies the final ${key} request even when the page suppresses the guard's events (capture + stopImmediatePropagation)`, async () => {
                for (const path of [`suppress-formdata-${key}`, `suppress-both-${key}`]) {
                    const error = await expectCode(clickExpecting(`/${path}`), 'APPROVAL_EXPIRED')
                    expect(error.mayHaveSideEffects, path).toBe(true)
                }
                // Nothing changed: the request itself is the verdict, and it matches.
                await clickExpecting(`/suppress-clean-${key}`)
                expect(await eventually(() => a.hits(`suppress-clean-${key}`), (n) => n === 1)).toBe(1)
                await delay(800)
                expect(a.hits(`suppress-formdata-${key}`) + a.hits(`suppress-both-${key}`)).toBe(0)
            })
        }

        it('rejects a changed submission when the guard gives no verdict at all (reports lost)', async () => {
            const silent = new CdpDriver({ browserWsUrl: chrome.browserWsUrl, browserInstanceIdProvider: async () => instanceId, testHooks: { dropGuardReports: () => true } })
            await silent.connect()
            try {
                for (const path of ['/late-bubble-post', '/late-bubble-get']) {
                    const tab = await silent.openTab(a.url(path), [a.origin], OPTS)
                    const obs = await silent.observe(tab.tabId, [a.origin], OPTS)
                    const ref = obs.elements.find((e) => e.name === 'Pay')!.ref
                    const expectation = expectationOf(await silent.describeRef(tab.tabId, ref, obs.snapshotId, OPTS))
                    await expectCode(silent.click(tab.tabId, ref, obs.snapshotId, { ...OPTS, expect: expectation }), 'APPROVAL_EXPIRED')
                }
                await delay(800)
                expect(a.hits('late-bubble-post') + a.hits('late-bubble-get')).toBe(0)
            } finally {
                await silent.close()
            }
        })

        it('does not send a submission it cannot verify (a file added mid-click while the guard is blinded)', async () => {
            const error = await expectCode(clickExpecting('/suppress-file'), 'APPROVAL_EXPIRED')
            expect(error.mayHaveSideEffects).toBe(true)
            await delay(800)
            expect(a.hits('suppress-file')).toBe(0)
        })

        it('stops the submission when mousedown, click or later submit/formdata handlers changed it', async () => {
            for (const path of ['/guard-down', '/guard-click', '/guard-submit-late', '/guard-formdata']) {
                const error = await expectCode(clickExpecting(path), 'APPROVAL_EXPIRED')
                expect(error.mayHaveSideEffects, path).toBe(true)
            }
            await delay(800)
            expect(a.hits('g-post') + a.hits('g-other')).toBe(0)
        })
    })

    describe('stale refs', () => {
        it('rejects a ref whose node was replaced by a same-position decoy (10x, decoy clicks 0)', async () => {
            const tab = await open('/spa', [a.origin])
            for (let i = 0; i < 10; i++) {
                await driver.navigate(tab.tabId, a.url('/spa'), [a.origin], OPTS)
                const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
                const pay = refOf(obs, 'Pay')
                await harness.evaluate(tab.targetId, 'swap()')
                await expectCode(driver.click(tab.tabId, pay, obs.snapshotId, OPTS), 'STALE_REF')
            }
            await delay(200)
            expect(a.hits('decoy')).toBe(0)
            expect(a.hits('pay')).toBe(0)
            // A fresh observe sees the new button; clicking it is legitimate.
            const fresh = await driver.observe(tab.tabId, [a.origin], OPTS)
            await driver.click(tab.tabId, refOf(fresh, 'Pay'), fresh.snapshotId, OPTS)
            expect(await eventually(() => a.hits('decoy'), (n) => n === 1)).toBe(1)
        })

        it('re-verifies the target after the pointer arrives, so a hover-triggered swap is never clicked', async () => {
            const tab = await open('/spa-hover', [a.origin])
            for (let i = 0; i < 5; i++) {
                await driver.navigate(tab.tabId, a.url('/spa-hover'), [a.origin], OPTS)
                const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
                const error = await expectCode(driver.click(tab.tabId, refOf(obs, 'Pay'), obs.snapshotId, OPTS), 'STALE_REF')
                // Only a hover was sent; no press reached the page.
                expect(error.mayHaveSideEffects).toBe(false)
            }
            await delay(200)
            expect(a.hits('decoy')).toBe(0)
            expect(a.hits('pay')).toBe(0)
        })

        it('rejects refs after navigation and after a newer snapshot', async () => {
            const tab = await open('/spa', [a.origin])
            const first = await driver.observe(tab.tabId, [a.origin], OPTS)
            const second = await driver.observe(tab.tabId, [a.origin], OPTS)
            await expectCode(driver.click(tab.tabId, refOf(first, 'Pay'), first.snapshotId, OPTS), 'STALE_REF')
            await driver.navigate(tab.tabId, a.url('/spa'), [a.origin], OPTS)
            await expectCode(driver.click(tab.tabId, refOf(second, 'Pay'), second.snapshotId, OPTS), 'STALE_REF')
            await delay(200)
            expect(a.hits('pay')).toBe(0)
        })

        it('rejects refs into an iframe that was detached and re-attached (same-process and OOPIF)', async () => {
            const origins = [a.origin, b.origin]
            const tab = await open('/frames', origins)
            const obs = await driver.observe(tab.tabId, origins, OPTS)
            expect(obs.frames.find((f) => f.origin === b.origin)?.outOfProcess).toBe(true)
            const inner = refOf(obs, 'Inner')
            const buyB = refOf(obs, 'Buy', b.origin)
            const reattach = (id: string) => harness.evaluate(tab.targetId, `new Promise((resolve) => {
                const old = document.getElementById('${id}'); const src = old.src; old.remove()
                const f = document.createElement('iframe'); f.id = '${id}'; f.onload = () => resolve(1); f.src = src; document.body.appendChild(f)
            })`)
            await reattach('same')
            await reattach('cross')
            await expectCode(driver.click(tab.tabId, inner, obs.snapshotId, OPTS), 'STALE_REF')
            await expectCode(driver.click(tab.tabId, buyB, obs.snapshotId, OPTS), 'STALE_REF')
            await delay(200)
            expect(a.hits('inner')).toBe(0)
            expect(b.hits('b-buy')).toBe(0)
        })
    })

    describe('target screenshot', () => {
        it('captures the addressed background tab, not the tab in front (10x)', async () => {
            const red = await open('/color/red', [a.origin])
            const green = await open('/color/green', [a.origin])
            const front = await harness.openFrontTab(a.url('/color/blue'))
            try {
                for (let i = 0; i < 10; i++) {
                    for (const [tab, rgb] of [[red, [255, 0, 0]], [green, [0, 255, 0]]] as const) {
                        const shot = await driver.screenshot(tab.tabId, [a.origin], OPTS)
                        expect(shot.targetId).toBe(tab.targetId)
                        expect(shot.mimeType).toBe('image/png')
                        const png = decodePng(shot.data)
                        const [r, g, bl] = png.pixel(10, 10)
                        expect([r, g, bl]).toEqual(rgb)
                    }
                }
            } finally {
                await harness.closeTarget(front)
            }
        })

        it('returns ORIGIN_DENIED when any frame origin is not allowed, and an image when all are', async () => {
            const tab = await open('/oopif', [a.origin, b.origin])
            await expectCode(driver.screenshot(tab.tabId, [a.origin], OPTS), 'ORIGIN_DENIED')
            const shot = await driver.screenshot(tab.tabId, [a.origin, b.origin], OPTS)
            expect(decodePng(shot.data).width).toBeGreaterThan(0)
        })

        it('discards the image when the frame tree changes during capture', async () => {
            let targetId = ''
            const hooked = new CdpDriver({
                browserWsUrl: chrome.browserWsUrl,
                browserInstanceIdProvider: async () => instanceId,
                testHooks: {
                    afterCapture: async () => {
                        await harness.evaluate(targetId, `new Promise((resolve) => { const f = document.getElementById('fb'); f.onload = () => resolve(1); f.src = f.src.split('?')[0] + '?n=' + Date.now() })`)
                    },
                },
            })
            await hooked.connect()
            try {
                const tab = await hooked.openTab(a.url('/oopif'), [a.origin, b.origin], OPTS)
                targetId = tab.targetId
                const error = await expectCode(hooked.screenshot(tab.tabId, [a.origin, b.origin], OPTS), 'ORIGIN_DENIED')
                expect(error.retryable).toBe(true)
                await hooked.closeTab(tab.tabId, OPTS)
            } finally {
                await hooked.close()
            }
        })
    })

    describe('destination enforcement before requests', () => {
        it('blocks redirect hops to a disallowed origin before they are sent, including one that would bounce back', async () => {
            await expectCode(driver.openTab(a.url('/redir-hit'), [a.origin], OPTS), 'ORIGIN_DENIED')
            await expectCode(driver.openTab(a.url('/via-c'), [a.origin], OPTS), 'ORIGIN_DENIED')
            const tab = await open('/plain', [a.origin])
            await expectCode(driver.navigate(tab.tabId, a.url('/via-c'), [a.origin], OPTS), 'ORIGIN_DENIED')
            expect(c.hits('redirect')).toBe(0)
            expect(bounceCount()).toBe(0)
        })

        it('never lets an owned page, its frames or its popups reach a disallowed destination', async () => {
            const tab = await open('/exfil', [a.origin])
            const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            for (const name of ['Open window', 'Open noopener', 'Blank link', 'Fetch away', 'Beacon away', 'Post away']) {
                await driver.click(tab.tabId, refOf(obs, name), obs.snapshotId, OPTS).catch(() => undefined)
                await delay(300)
            }
            const meta = await open('/meta-refresh', [a.origin])
            await delay(2_500)
            for (const hit of ['open', 'noopener', 'blank', 'post', 'fetch', 'beacon', 'frame', 'meta']) expect(c.hits(hit), hit).toBe(0)
            expect(driver.blockedReports().filter((report) => report.origin === c.origin).length).toBeGreaterThanOrEqual(6)
            expect(JSON.stringify(driver.blockedReports())).not.toContain('/hit/')
            // Popups whose document was stopped are closed (the owned tabs keep their error pages).
            const owned = new Set([tab.targetId, meta.targetId])
            const stray = (t: Array<{ targetId: string; url: string }>) => t.filter((x) => !owned.has(x.targetId) && x.url.startsWith(c.origin))
            expect(stray(await eventually(() => harness.targets(), (t) => stray(t).length === 0))).toEqual([])
            expect(driver.popupReports().filter((p) => p.openerTabId === tab.tabId && p.origin === c.origin).every((p) => p.closed)).toBe(true)
        })

        it('still lets an owned page open an allowed popup and keeps enforcing inside it', async () => {
            const tab = await open('/exfil', [a.origin])
            const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            await driver.click(tab.tabId, refOf(obs, 'Open allowed'), obs.snapshotId, OPTS)
            const reports = await eventually(() => driver.popupReports(), (r) => r.some((p) => p.origin === a.origin && !p.closed))
            const popup = reports.find((p) => p.origin === a.origin && !p.closed)!
            await harness.evaluate(popup.targetId, `location.href = '${c.url('/hit/from-popup')}'`).catch(() => undefined)
            await delay(800)
            expect(c.hits('from-popup')).toBe(0)
            await harness.closeTarget(popup.targetId)
        })

        it('does not hold or touch tabs the driver does not own', async () => {
            const user = await harness.openFrontTab(c.url('/hit/user-tab'))
            await eventually(() => c.hits('user-tab'), (n) => n === 1)
            await harness.closeTarget(user)
        })
    })

    describe('navigation origin checks and popups', () => {
        it('refuses to open a disallowed origin or a redirect to one, leaving no owned tab', async () => {
            const before = driver.debugCounts()
            await expectCode(driver.openTab(c.url('/plain'), [a.origin], OPTS), 'ORIGIN_DENIED')
            await expectCode(driver.openTab(a.url('/redirect-to-c'), [a.origin], OPTS), 'ORIGIN_DENIED')
            expect(driver.debugCounts()).toEqual(before)
            const pages = await harness.targets()
            expect(pages.some((t) => t.url.startsWith(c.origin))).toBe(false)
        })

        it('stops a navigation that redirects to a disallowed origin', async () => {
            const tab = await open('/plain', [a.origin])
            const error = await expectCode(driver.navigate(tab.tabId, a.url('/redirect-to-c'), [a.origin], OPTS), 'ORIGIN_DENIED')
            expect(error.mayHaveSideEffects).toBe(true)
            await expectCode(driver.observe(tab.tabId, [a.origin], OPTS), 'ORIGIN_DENIED')
            await expectCode(driver.screenshot(tab.tabId, [a.origin], OPTS), 'ORIGIN_DENIED')
        })

        it('does not adopt popups and closes those on disallowed origins', async () => {
            const tab = await open('/popup', [a.origin])
            const before = driver.debugCounts()
            const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            await driver.click(tab.tabId, refOf(obs, 'Open C'), obs.snapshotId, OPTS)
            const mine = (r: ReturnType<typeof driver.popupReports>) => r.filter((p) => p.openerTabId === tab.tabId)
            const reports = await eventually(() => mine(driver.popupReports()), (r) => r.some((p) => p.origin === c.origin && p.closed))
            expect(reports.find((p) => p.origin === c.origin)).toMatchObject({ openerTabId: tab.tabId, closed: true })
            const gone = await eventually(() => harness.targets(), (t) => !t.some((x) => x.url.startsWith(c.origin)))
            expect(gone.some((t) => t.url.startsWith(c.origin))).toBe(false)

            await driver.click(tab.tabId, refOf(obs, 'Open A'), obs.snapshotId, OPTS)
            const withA = await eventually(() => mine(driver.popupReports()), (r) => r.some((p) => p.origin === a.origin))
            const popupA = withA.find((p) => p.origin === a.origin)!
            expect(popupA.closed).toBe(false)
            // Never adopted as an owned tab, but it is a live agent window.
            expect(driver.debugCounts()).toEqual({ ...before, windows: before.windows + 1 })
            await harness.closeTarget(popupA.targetId)
        })
    })

    describe('waitFor', () => {
        it('resolves text and url predicates', async () => {
            const tab = await open('/later', [a.origin])
            await driver.waitFor(tab.tabId, { kind: 'text', text: 'Arrived later' }, [a.origin], OPTS)
            await driver.waitFor(tab.tabId, { kind: 'url', urlPrefix: a.url('/later/done') }, [a.origin], OPTS)
        })

        it('resolves a ref predicate once the element becomes visible', async () => {
            const tab = await open('/reveal', [a.origin])
            const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            const reveal = refOf(obs, 'Reveal')
            await driver.waitFor(tab.tabId, { kind: 'ref', ref: reveal }, [a.origin], OPTS)
            await driver.click(tab.tabId, reveal, obs.snapshotId, OPTS)
            expect(await eventually(() => a.hits('reveal'), (n) => n === 1)).toBe(1)
        })

        it('rejects within 50ms of abort and honours timeoutMs', async () => {
            const tab = await open('/plain', [a.origin])
            const controller = new AbortController()
            const pending = driver.waitFor(tab.tabId, { kind: 'text', text: 'never-appears' }, [a.origin], { timeoutMs: 30_000, signal: controller.signal })
            await delay(250)
            const abortedAt = Date.now()
            controller.abort()
            await expectCode(pending, 'OUTCOME_UNKNOWN')
            expect(Date.now() - abortedAt).toBeLessThan(50)

            const started = Date.now()
            const error = await expectCode(driver.waitFor(tab.tabId, { kind: 'text', text: 'never-appears' }, [a.origin], { timeoutMs: 300 }), 'OUTCOME_UNKNOWN')
            expect(error.mayHaveSideEffects).toBe(false)
            expect(Date.now() - started).toBeGreaterThanOrEqual(290)
            expect(Date.now() - started).toBeLessThan(1_000)
        })

        it('does not match text inside a frame whose origin is not allowed', async () => {
            const tab = await open('/oopif', [a.origin])
            await expectCode(driver.waitFor(tab.tabId, { kind: 'text', text: 'canary-b-7788' }, [a.origin], { timeoutMs: 600 }), 'OUTCOME_UNKNOWN')
        })
    })

    describe('closeTab', () => {
        it('closes the target and releases tab and session registrations (5 cycles, OOPIF page)', async () => {
            const baseline = driver.debugCounts()
            for (let i = 0; i < 5; i++) {
                const tab = await driver.openTab(a.url('/oopif'), [a.origin, b.origin], OPTS)
                await driver.observe(tab.tabId, [a.origin, b.origin], OPTS)
                expect(driver.debugCounts().sessions).toBeGreaterThan(baseline.sessions + 1)
                expect(await driver.closeTab(tab.tabId, OPTS)).toEqual({ closed: true })
                expect(driver.hasTab(tab.tabId)).toBe(false)
                expect(await driver.closeTab(tab.tabId, OPTS)).toEqual({ closed: true })
                const targets = await harness.targets()
                expect(targets.some((t) => t.targetId === tab.targetId)).toBe(false)
            }
            expect(driver.debugCounts()).toEqual(baseline)
        })

        it('does not accept a beforeunload prompt and reports it', async () => {
            const tab = await open('/beforeunload', [a.origin])
            const obs = await driver.observe(tab.tabId, [a.origin], OPTS)
            await driver.click(tab.tabId, refOf(obs, 'Touch'), obs.snapshotId, OPTS)
            await eventually(() => a.hits('bu'), (n) => n === 1)
            expect(await driver.closeTab(tab.tabId, OPTS)).toEqual({ closed: false, beforeUnloadBlocked: true })
            expect(driver.hasTab(tab.tabId)).toBe(true)
            await harness.closeTarget(tab.targetId)
            expect(await eventually(() => driver.hasTab(tab.tabId), (owned) => !owned)).toBe(false)
        })
    })

    describe('runtime restart', () => {
        it('lets a new driver re-take an owned tab by targetId and never adopts unknown targets', async () => {
            const tab = await driver.openTab(a.url('/plain'), [a.origin], OPTS)
            // A second driver on the same browser plays the restarted Runtime.
            const restarted = new CdpDriver({ browserWsUrl: chrome.browserWsUrl, browserInstanceIdProvider: async () => instanceId })
            try {
                await restarted.connect()
                expect(restarted.hasTab(tab.tabId)).toBe(false)
                expect(await restarted.adoptTab(tab.tabId, tab.targetId, [a.origin], OPTS)).toBe(true)
                expect(restarted.hasTab(tab.tabId)).toBe(true)
                const observation = await restarted.observe(tab.tabId, [a.origin], OPTS)
                expect(observation.text).toContain('Alpha plain page')
                expect(await restarted.adoptTab('tab-other' as TabId, 'no-such-target', [a.origin], OPTS)).toBe(false)
                expect(restarted.hasTab('tab-other' as TabId)).toBe(false)
            } finally {
                await restarted.close()
                await driver.closeTab(tab.tabId, OPTS)
            }
        })
    })

    describe('connection loss', () => {
        it('rejects pending calls with RUNTIME_UNAVAILABLE, drops tabs, and reconnects only explicitly', async () => {
            const first = await launchChrome()
            let second: LaunchedChrome | undefined
            let n = 0
            const lossy = new CdpDriver({ browserWsUrl: first.browserWsUrl, browserInstanceIdProvider: async () => `bi-loss-${++n}` as BrowserInstanceId })
            try {
                const firstId = await lossy.connect()
                let disconnects = 0
                lossy.onDisconnect(() => { disconnects++ })
                const tab = await lossy.openTab(a.url('/plain'), [a.origin], OPTS)
                const pending = lossy.waitFor(tab.tabId, { kind: 'text', text: 'never-appears' }, [a.origin], { timeoutMs: 30_000 })
                // Observe the rejection before killing Chrome, so it is never momentarily unhandled.
                const pendingRejected = expectCode(pending, 'RUNTIME_UNAVAILABLE')
                await delay(200)
                await first.kill()
                await pendingRejected
                expect(lossy.hasTab(tab.tabId)).toBe(false)
                expect(lossy.debugCounts()).toEqual({ tabs: 0, sessions: 0, windows: 0 })
                expect(disconnects).toBe(1)
                expect(lossy.isConnected()).toBe(false)
                expect(() => lossy.browserInstanceId()).toThrow()
                await expectCode(lossy.observe(tab.tabId, [a.origin], OPTS), 'RUNTIME_UNAVAILABLE')

                second = await launchChrome()
                const secondId = await lossy.reconnect(second.browserWsUrl)
                expect(secondId).not.toBe(firstId)
                expect(lossy.isConnected()).toBe(true)
                expect(disconnects).toBe(1)
                expect(lossy.browserInstanceId()).toBe(secondId)
                expect(lossy.hasTab(tab.tabId)).toBe(false)
                await expectCode(lossy.observe(tab.tabId, [a.origin], OPTS), 'TARGET_GONE')
            } finally {
                await lossy.close()
                await first.stop()
                await second?.stop()
            }
        })
    })
})
