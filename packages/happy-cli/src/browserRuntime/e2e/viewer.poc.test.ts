/**
 * GD2 on real containers (S4): the Runtime's viewer proxy is the only way to
 * the browser display. Raw RFB KeyEvent/PointerEvent/ClientCutText sent through
 * it without a takeover never reach the page (fixture ledger); with a takeover
 * by the same viewer they do; after release they stop again.
 *
 * The stack runs in the production viewer layout (`viewer: 'runtime'`): no
 * noVNC, x11vnc listening only on the profile networks with the per-run
 * password. Target window focus is harness setup (xdotool windowfocus; there
 * is no window manager); every key and click goes through the proxy.
 */
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PROFILE_A, SITE_A, startPocStack, type LedgerEntry, type PocStack } from './pocStack'
import { Viewer, cleanupTask, clientFor, evidence, mintAgent, mintInteractive, range, repeat, rid, runtimePort, sleep, tagOf, waitForTask } from './a02a04Helpers'
import { ENCODING, keyEvent, pointerEvent, setEncodingsMessage } from '../rfb'
import { RawRfbViewer } from '../testing/rfbViewerClient'
import { u16, u32 } from '../testing/rfbFixtures'

const ITERATIONS = repeat(1)
const STRICT_PASSWORD = 'correct-horse'
/** Long enough for x11vnc → XTest → Chromium → form POST → ledger when input does get through. */
const NEGATIVE_WAIT_MS = 3_000

let stack: PocStack
beforeAll(async () => { stack = await startPocStack({ viewer: 'runtime' }) }, 300_000)
afterAll(() => stack?.down({ purge: true }))

const keysym = (char: string) => char.charCodeAt(0)
const TAB = 0xff09
const RETURN = 0xff0d
function typing(text: string, ...specials: number[]): Buffer {
    const keys = [...text].map(keysym).concat(specials)
    return Buffer.concat(keys.flatMap((key) => [keyEvent(true, key), keyEvent(false, key)]))
}
/** The full login a human would type into the autofocused form: user, Tab, password, Return. */
const loginKeystrokes = () => Buffer.concat([typing('human-a', TAB), typing(STRICT_PASSWORD, RETURN)])
const cutText = (text: string) => Buffer.concat([Buffer.from([6, 0, 0, 0]), u32(text.length), Buffer.from(text)])
const fullUpdateRequest = (width: number, height: number) => Buffer.concat([Buffer.from([3, 0]), u16(0), u16(0), u16(width), u16(height)])
const logins = (entries: LedgerEntry[], tag: string) => entries.filter((entry) => entry.kind === 'a02a04-login' && entry.tag === tag)

/** An agent task whose tab shows the strict login form, focused on the display (harness setup, not input). */
async function openLoginTask(tag: string) {
    const { token } = mintAgent(stack, { profileId: PROFILE_A })
    const agent = clientFor(stack, token)
    const { taskSpaceId } = await agent.createSpace({ profileId: PROFILE_A, requestId: rid() })
    const task = await agent.createTask({ taskSpaceId, requestId: rid() })
    // A viewer that just lost control keeps the profile fenced until x11vnc consumed its input (milliseconds).
    let opened: Awaited<ReturnType<typeof agent.openPage>> | undefined
    for (let attempt = 0; !opened; attempt++) {
        try {
            opened = await agent.openPage({ taskId: task.taskId, url: `${SITE_A}/login-strict/${tag}?run=${stack.run}`, requestId: rid() })
        } catch (error) {
            if ((error as { code?: string }).code !== 'STALE_LEASE' || attempt >= 20) throw error
            await sleep(250)
        }
    }
    await new Viewer(stack, 'a').bringToFront(`ABP strict login ${tag}`)
    return { agent, taskSpaceId, taskId: task.taskId, tabId: opened.tabId }
}

async function openViewer(interactive: string): Promise<{ viewer: RawRfbViewer; width: number; height: number }> {
    const port = runtimePort(stack)
    const { ticket } = await clientFor(stack, interactive).viewerTicket({ profileId: PROFILE_A })
    const viewer = await RawRfbViewer.open(`ws://127.0.0.1:${port}/v1/viewer/websockify?ticket=${ticket}`, `http://127.0.0.1:${port}`)
    const init = await viewer.handshake()
    viewer.send(setEncodingsMessage([ENCODING.hextile, ENCODING.copyRect, ENCODING.raw, ENCODING.desktopSize, ENCODING.cursor]))
    viewer.send(fullUpdateRequest(init.width, init.height))
    return { viewer, width: init.width, height: init.height }
}

describe('GD2 viewer proxy on the real stack', () => {
    it('serves the pinned noVNC client and publishes no noVNC or VNC port', async () => {
        const base = `http://127.0.0.1:${runtimePort(stack)}`
        const page = await fetch(`${base}/viewer/`)
        expect(page.status).toBe(200)
        expect(await page.text()).toContain('noVNC')
        expect((await fetch(`${base}/viewer/core/rfb.js`)).headers.get('content-type')).toBe('text/javascript; charset=utf-8')
        expect(stack.env.ports.novncA).toBeUndefined()
        for (const container of [stack.env.containers.browserA, stack.env.containers.browserB]) {
            expect(execFileSync('docker', ['port', container], { encoding: 'utf8' }).trim()).toBe('')
        }
    })

    it.each(range(ITERATIONS))('iteration %i: raw RFB input reaches the page only during this viewer\'s takeover', async (i) => {
        const tag = tagOf('vw', i)
        const tasks: Array<Awaited<ReturnType<typeof openLoginTask>>> = []
        try {
            const first = await openLoginTask(tag)
            tasks.push(first)
            const interactive = mintInteractive(stack)
            const human = clientFor(stack, interactive)
            const { viewer, width, height } = await openViewer(interactive)
            const viewers = [viewer]
            try {
                // The display is visible without control: framebuffer data arrives through the framed server stream.
                const deadline = Date.now() + 10_000
                while (viewer.received().length < 1024 && Date.now() < deadline) await sleep(100)
                const framebufferBytes = viewer.received().length
                expect(framebufferBytes, 'framebuffer update through the proxy').toBeGreaterThan(1024)

                // 1) No takeover: a click on the form, a paste and the whole login must not reach the page.
                viewer.send(Buffer.concat([pointerEvent(1, width >> 1, height >> 1), pointerEvent(0, width >> 1, height >> 1), cutText('pasted'), loginKeystrokes()]))
                await sleep(NEGATIVE_WAIT_MS)
                expect(logins(await stack.ledger(), tag), 'login submitted without takeover').toEqual([])

                // 2) Takeover by this viewer's capability: the same keystrokes log in.
                const lease = (await human.getTask({ taskId: first.taskId })).tabLeases!.find((l) => l.tabId === first.tabId)!
                const control = await human.takeOver({ taskId: first.taskId, tabId: first.tabId, expectedEpoch: lease.leaseEpoch, requestId: rid() })
                await waitForTask(human, first.taskId, (t) => t.tabLeases?.find((l) => l.tabId === first.tabId)?.owner.kind === 'user', 15_000)
                const owned = (await human.getTask({ taskId: first.taskId })).tabLeases!.find((l) => l.tabId === first.tabId)!
                viewer.send(loginKeystrokes())
                const during = await stack.waitForLedger((entries) => logins(entries, tag).length > 0, { timeoutMs: 15_000 })
                expect(logins(during, tag).map((entry) => entry.ok), 'login during takeover').toEqual([true])

                // 3) Released after input: the viewer is closed (4002) once x11vnc consumed everything; the
                //    reconnected viewer types into a fresh login form and nothing arrives.
                await human.releaseControl({ taskId: first.taskId, tabId: first.tabId, expectedEpoch: owned.leaseEpoch, requestId: rid() })
                expect((await viewer.closed).code, 'viewer closed after control loss with input').toBe(4002)
                const second = await openLoginTask(`${tag}-r`)
                tasks.push(second)
                const again = await openViewer(interactive)
                viewers.push(again.viewer)
                again.viewer.send(loginKeystrokes())
                await sleep(NEGATIVE_WAIT_MS)
                const after = await stack.ledger()
                expect(logins(after, `${tag}-r`), 'login after release').toEqual([])
                expect(again.viewer.ws.readyState, 'view-only connection stays open').toBe(1)
                evidence({ gate: 'GD2', i, framebufferBytes, settling: control.settling ?? false, withoutTakeover: 0,
                    duringTakeover: logins(during, tag).length, afterRelease: logins(after, `${tag}-r`).length })
            } finally {
                for (const open of viewers) open.ws.close()
            }
        } finally {
            for (const task of tasks) await cleanupTask(task.agent, task.taskId, task.taskSpaceId)
        }
    }, 120_000)

    /** The capability payload (abp1.<payload>.<sig>) names the capability the admin socket revokes. */
    const capabilityIdOf = (token: string): string => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).capabilityId

    it.each(range(ITERATIONS).flatMap((i) => (['expiry', 'revocation'] as const).map((end) => [i, end] as const)))(
        'iteration %i: at capability %s during a takeover no raw RFB input reaches the page and the viewer is closed', async (i, end) => {
            const tag = tagOf(end === 'expiry' ? 've' : 'vr', i)
            const task = await openLoginTask(tag)
            const ttlMs = end === 'expiry' ? 20_000 : 30 * 60_000
            const issuedAt = Date.now()
            const interactive = mintInteractive(stack, { ttlMs })
            const human = clientFor(stack, interactive)
            const { viewer } = await openViewer(interactive)
            try {
                const lease = (await human.getTask({ taskId: task.taskId })).tabLeases!.find((l) => l.tabId === task.tabId)!
                await human.takeOver({ taskId: task.taskId, tabId: task.tabId, expectedEpoch: lease.leaseEpoch, requestId: rid() })
                await waitForTask(human, task.taskId, (t) => t.tabLeases?.find((l) => l.tabId === task.tabId)?.owner.kind === 'user', 15_000)
                if (end === 'expiry') await sleep(Math.max(0, issuedAt + ttlMs - Date.now()) + 50)
                else await stack.admin('/admin/revoke-capability', { capabilityId: capabilityIdOf(interactive) })
                // Straight after the end: the whole login, as a human still typing would send it.
                if (viewer.ws.readyState === 1) viewer.send(loginKeystrokes())
                const closed = await Promise.race([viewer.closed.then((c) => c.code), sleep(10_000).then(() => undefined)])
                await sleep(NEGATIVE_WAIT_MS)
                const entries = logins(await stack.ledger(), tag)
                evidence({ gate: 'GD2', path: `takeover-then-${end}`, i, closeCode: closed ?? null, loginsAfterEnd: entries.length })
                expect(entries, `login after capability ${end}`).toEqual([])
                expect(closed, `viewer closed after capability ${end}`).toBeDefined()
            } finally {
                viewer.ws.close()
                // The takeover belongs to the user's viewer session, not to the ended capability: it stays (and fences
                // the profile) until released, so a renewed capability for the same viewer session releases it.
                const viewerSessionId = JSON.parse(Buffer.from(interactive.split('.')[1], 'base64url').toString('utf8')).viewerSessionId as string
                const fresh = clientFor(stack, stack.mintInteractive({ viewerSessionId }))
                const held = (await fresh.getTask({ taskId: task.taskId })).tabLeases?.find((l) => l.tabId === task.tabId)
                if (held?.owner.kind === 'user') await fresh.releaseControl({ taskId: task.taskId, tabId: task.tabId, expectedEpoch: held.leaseEpoch, requestId: rid() })
                await cleanupTask(task.agent, task.taskId, task.taskSpaceId)
            }
        }, 120_000)
})
