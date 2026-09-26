/**
 * A11 — bypass / origin / secret (R11). Source: Saydo
 * specs/agent-browser-poc/acceptance.md A11.
 *
 * Not covered here (owned elsewhere): the agent-sandbox part (agent reading
 * profile/control files or the Runtime socket) and the flag-profile regression
 * of the existing Happy browser tools.
 */
import { createHmac, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AGENT_OPERATIONS, type Operation } from '../contracts'
import { canonicalJson } from '../policy'
import {
    admin, allEvents, cleanupSpace, client, containerLogs, count, decodePng, docker, evidence, expectCode, ledgerRun, mintAgent, mintInteractive,
    newTaskWithPage, pageUrl, range, rawOp, repeat, rid, settledLedger, step,
} from './a05a06a08a09a11Helpers'
import { MACHINE, PRINCIPAL_A, PROFILE_A, SITE_A, SITE_B, SITE_C, WORKSPACE, startPocStack, type PocStack } from './pocStack'

const N = repeat(10)

/** Signs an arbitrary payload in the Runtime token format (what a forger holding a key could do). */
function forge(payload: Record<string, unknown>, key: string | Buffer): string {
    const body = Buffer.from(canonicalJson(payload)).toString('base64url')
    return `abp1.${body}.${createHmac('sha256', key).update(`abp1.${body}`).digest('base64url')}`
}

function agentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const now = Date.now()
    return {
        kind: 'agent-grant', grantId: `grant-${randomUUID()}`, principalId: PRINCIPAL_A, workspaceId: WORKSPACE, machineId: MACHINE,
        agentSessionId: `agent-${randomUUID()}`, profileId: PROFILE_A, allowedOrigins: [SITE_A, SITE_B], operations: [...AGENT_OPERATIONS],
        taskSpaceIds: [], issuedAtMs: now - 5_000, expiresAtMs: now + 10 * 60_000, ...overrides,
    }
}

/** Speaks just enough RFB over the noVNC websocket to read the offered security types. */
async function vncSecurityTypes(port: number): Promise<number[]> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/websockify`, ['binary'])
        ws.binaryType = 'arraybuffer'
        let stage = 0
        const timer = setTimeout(() => { ws.close(); reject(new Error('no RFB handshake')) }, 5_000)
        ws.onmessage = (event) => {
            const data = Buffer.from(event.data as ArrayBuffer)
            if (stage === 0) {
                stage = 1
                ws.send(Buffer.from('RFB 003.008\n'))
            } else {
                clearTimeout(timer)
                ws.close()
                resolve([...data.subarray(1, 1 + data[0])])
            }
        }
        ws.onerror = () => { clearTimeout(timer); reject(new Error('websocket error')) }
    })
}

function grepVolume(stack: PocStack, needle: string): string[] {
    const out = docker(['run', '--rm', '-v', `abp-${stack.run}-state:/s:ro`, '--entrypoint', 'sh', `abp-runtime:${process.env.ABP_IMAGE_TAG ?? 'poc'}`, '-c', `grep -rlF -- "$0" /s || true`, needle])
    return out.split('\n').filter(Boolean)
}

describe('A11 bypass, origin and secrets', () => {
    let stack: PocStack
    beforeAll(async () => { stack = await startPocStack() }, 300_000)
    afterAll(() => stack?.down({ purge: true }))

    it.each(range(N))('unauthenticated, forged, wrong-kind, expired and revoked credentials are refused with no side effect #%i', async (i) => {
        const L = ledgerRun(stack, `a11-auth-${i}`)
        const agent = client(stack, mintAgent(stack).token)
        const t = await newTaskWithPage(agent, pageUrl(stack, SITE_A, '/x5/panel', { label: 'A' }, L))
        try {
            const press = (await agent.observe({ taskId: t.taskId, tabId: t.tabId })).elements.find((e) => e.name === 'Press A')!.ref
            const batch = { taskId: t.taskId, expectedVersion: t.version, requestId: rid(), steps: [step(t.tabId, 'click', { ref: press })] }
            const results: Record<string, string> = {}
            const tryRaw = async (label: string, headers: Record<string, string>, op = 'submitBatch', body: unknown = batch) => {
                const r = await rawOp(stack, op, body, headers)
                results[label] = `${r.status}:${r.json.error?.code}`
                return r
            }
            await tryRaw('no-auth', {})
            await tryRaw('garbage', { authorization: 'Bearer not-a-token' })
            await tryRaw('agent-kind-signed-with-interactive-key', { authorization: `Bearer ${forge(agentPayload(), stack.keys.interactiveKey)}` })
            await tryRaw('interactive-kind-signed-with-agent-key', { authorization: `Bearer ${forge({ ...agentPayload(), kind: 'interactive', capabilityId: 'cap-x', viewerSessionId: 'v', operations: ['approve', 'takeOver', 'releaseControl', 'getTask', 'subscribe'] }, stack.keys.agentKey)}` })
            await tryRaw('agent-grant-with-approve-op', { authorization: `Bearer ${forge(agentPayload({ operations: [...AGENT_OPERATIONS, 'approve'] as Operation[] }), stack.keys.agentKey)}` }, 'getTask', { taskId: t.taskId })
            await tryRaw('expired', { authorization: `Bearer ${forge(agentPayload({ issuedAtMs: Date.now() - 120_000, expiresAtMs: Date.now() - 60_000 }), stack.keys.agentKey)}` })
            const revoked = mintAgent(stack)
            await admin(stack, '/admin/revoke-grant', { grantId: revoked.grantId })
            await tryRaw('revoked', { authorization: `Bearer ${revoked.token}` }, 'getTask', { taskId: t.taskId })
            for (const [label, value] of Object.entries(results)) expect(value, label).toBe('401:UNAUTHORIZED')

            const ui = client(stack, mintInteractive(stack).token)
            const wrongKind = [
                (await expectCode(ui.submitBatch(batch), 'SCOPE_DENIED', 'interactive submitBatch')).code,
                (await expectCode(ui.createSpace({ profileId: PROFILE_A, requestId: rid() }), 'SCOPE_DENIED', 'interactive createSpace')).code,
                (await expectCode(ui.openPage({ taskId: t.taskId, url: pageUrl(stack, SITE_A, '/marker'), requestId: rid() }), 'SCOPE_DENIED', 'interactive openPage')).code,
            ]
            const ledger = await settledLedger(stack, L, 1_000)
            const task = await agent.getTask({ taskId: t.taskId })
            evidence('A11', { path: 'credentials', i, results, interactiveAsAgent: wrongKind, presses: count(ledger, 'click'), version: [t.version, task.stateVersion] })
            expect(count(ledger, 'click')).toBe(0)
            expect(task.stateVersion).toBe(t.version)
        } finally {
            expect(await cleanupSpace(stack, agent, t.taskSpaceId, [t.taskId])).toBeUndefined()
        }
    })

    it.each(range(N))('agent grant cannot approve / takeOver / releaseControl; human:true is not honoured #%i', async (i) => {
        const L = ledgerRun(stack, `a11-self-${i}`)
        const g = mintAgent(stack)
        const agent = client(stack, g.token)
        const t = await newTaskWithPage(agent, pageUrl(stack, SITE_A, '/risky-submit', {}, L))
        try {
            const confirm = (await agent.observe({ taskId: t.taskId, tabId: t.tabId })).elements.find((e) => e.name === 'Confirm payment')!.ref
            const r = await agent.submitBatch({ taskId: t.taskId, expectedVersion: t.version, requestId: rid(), steps: [step(t.tabId, 'click', { ref: confirm })] }, { waitMs: 30_000 })
            const pending = r.result!.pendingApproval!
            const approveReq = { taskId: t.taskId, approvalId: pending.approvalId, bindingHash: pending.bindingHash, requestId: rid(), decision: 'approve' as const }
            const codes = [
                (await expectCode(agent.approve(approveReq), 'SCOPE_DENIED', 'agent approve')).code,
                (await expectCode(agent.takeOver({ taskId: t.taskId, tabId: t.tabId, expectedEpoch: 1, requestId: rid() }), 'SCOPE_DENIED', 'agent takeOver')).code,
                (await expectCode(agent.releaseControl({ taskId: t.taskId, tabId: t.tabId, expectedEpoch: 1, requestId: rid() }), 'SCOPE_DENIED', 'agent releaseControl')).code,
            ]
            const human = await rawOp(stack, 'approve', { ...approveReq, requestId: rid(), human: true }, { authorization: `Bearer ${g.token}` })
            const humanUi = await rawOp(stack, 'approve', { ...approveReq, requestId: rid(), human: true, principalId: PRINCIPAL_A }, { authorization: `Bearer ${mintInteractive(stack).token}` })
            const ledger = await settledLedger(stack, L, 1_500)
            const task = await agent.getTask({ taskId: t.taskId })
            evidence('A11', { path: 'agent-self-approval', i, codes, humanFlagAgent: `${human.status}:${human.json.error?.code}`, humanFlagUi: `${humanUi.status}:${humanUi.json.error?.code}`, riskyWrites: count(ledger, 'risky'), status: task.status })
            expect(human.json.ok).not.toBe(true)
            expect(humanUi.status, 'unknown body fields (human, principalId) must be rejected, not interpreted').toBe(400)
            expect(count(ledger, 'risky')).toBe(0)
            expect(task.status).toBe('awaiting-user')
        } finally {
            expect(await cleanupSpace(stack, agent, t.taskSpaceId, [t.taskId])).toBeUndefined()
        }
    })

    it.each(range(N))('redirect, direct navigation and popup cannot extend scope to site C #%i', async (i) => {
        const L = ledgerRun(stack, `a11-origin-${i}`)
        const agent = client(stack, mintAgent(stack).token)
        const space = (await agent.createSpace({ profileId: PROFILE_A, requestId: rid() })).taskSpaceId
        const ids: Parameters<typeof cleanupSpace>[3] = []
        try {
            // 1. openPage on an allowed URL that redirects to C.
            const redirTask = await agent.createTask({ taskSpaceId: space, requestId: rid() })
            ids.push(redirTask.taskId)
            const redirect = await expectCode(agent.openPage({ taskId: redirTask.taskId, url: pageUrl(stack, SITE_A, '/redirect', { to: `${SITE_C}/secret?run=${L}` }), requestId: rid() }), ['ORIGIN_DENIED', 'OUTCOME_UNKNOWN'], 'openPage redirect to C')
            const redirView = await agent.getTask({ taskId: redirTask.taskId })
            // 2. navigate step directly to C and via redirect.
            const t = await newTaskWithPage(agent, pageUrl(stack, SITE_A, '/popup', {}, L), { taskSpaceId: space })
            ids.push(t.taskId)
            const stepOutcome = (p: Promise<{ result?: { outcome: string; steps: Array<{ error?: { code: string } }> } }>) => p
                .then((x) => `${x.result?.outcome}:${x.result?.steps.find((st) => st.error)?.error?.code ?? ''}`)
                .catch((e: { code?: string }) => `rejected:${e.code}`)
            const direct = await stepOutcome(agent.submitBatch({ taskId: t.taskId, expectedVersion: t.version, requestId: rid(), steps: [step(t.tabId, 'navigate', { url: `${SITE_C}/secret?run=${L}` })] }, { waitMs: 30_000 }))
            const t2 = await newTaskWithPage(agent, pageUrl(stack, SITE_A, '/x5/panel', { label: 'R' }, L), { taskSpaceId: space })
            ids.push(t2.taskId)
            const viaRedirect = await stepOutcome(agent.submitBatch({ taskId: t2.taskId, expectedVersion: t2.version, requestId: rid(), steps: [step(t2.tabId, 'navigate', { url: pageUrl(stack, SITE_A, '/redirect', { to: `${SITE_C}/secret?run=${L}` }) })] }, { waitMs: 30_000 }))
            const afterNav = await agent.getTask({ taskId: t2.taskId })
            // 3. popup to C from a fresh allowed page.
            const p = await newTaskWithPage(agent, pageUrl(stack, SITE_A, '/popup', {}, L), { taskSpaceId: space })
            ids.push(p.taskId)
            const btn = (await agent.observe({ taskId: p.taskId, tabId: p.tabId })).elements.find((e) => e.name === 'Open popup')!.ref
            const popup = await agent.submitBatch({ taskId: p.taskId, expectedVersion: p.version, requestId: rid(), steps: [step(p.tabId, 'click', { ref: btn })] }, { waitMs: 30_000 })
            const afterPopup = await agent.getTask({ taskId: p.taskId })
            const obs = await agent.observe({ taskId: p.taskId, tabId: p.tabId })
            const leaked = JSON.stringify([redirView, afterNav, afterPopup, obs, popup, viaRedirect]).includes('ABP-CANARY-FRAME')
            evidence('A11', { path: 'origin-scope', i, redirectOpen: redirect.code, redirectTabs: redirView.tabs.length, directNavigate: direct, viaRedirect, popupTabs: afterPopup.tabs.length, popupObservedOrigin: new URL(obs.url).origin, leaked })
            expect(redirView.tabs, 'redirect to C must not yield a task tab').toHaveLength(0)
            expect(direct.startsWith('succeeded'), `direct navigation to C must fail (${direct})`).toBe(false)
            expect(direct).toMatch(/ORIGIN_DENIED/)
            expect(viaRedirect.startsWith('succeeded'), `redirect navigation to C must fail (${viaRedirect})`).toBe(false)
            expect(afterPopup.tabs, 'popup must not be adopted as a task tab').toEqual([p.tabId])
            expect(new URL(obs.url).origin).toBe(SITE_A)
            expect(leaked).toBe(false)
        } finally {
            expect(await cleanupSpace(stack, agent, space, ids)).toBeUndefined()
        }
    })

    it.each(range(N))('disallowed iframe: no canary in observe, screenshot ORIGIN_DENIED; both-origins control returns an image #%i', async (i) => {
        const L = ledgerRun(stack, `a11-frame-${i}`)
        const agent = client(stack, mintAgent(stack).token)
        const both = client(stack, mintAgent(stack, { allowedOrigins: [SITE_A, SITE_B, SITE_C] }).token)
        const t = await newTaskWithPage(agent, pageUrl(stack, SITE_A, '/canary-frame', {}, L))
        const c = await newTaskWithPage(both, pageUrl(stack, SITE_A, '/canary-frame', {}, L))
        try {
            const obs = await agent.observe({ taskId: t.taskId, tabId: t.tabId })
            const denied = await expectCode(agent.screenshot({ taskId: t.taskId, tabId: t.tabId }), 'ORIGIN_DENIED', 'screenshot with C frame')
            const batch = await agent.submitBatch({ taskId: t.taskId, expectedVersion: t.version, requestId: rid(), steps: [step(t.tabId, 'observe'), step(t.tabId, 'screenshot')] }, { waitMs: 30_000 })
            const control = await both.screenshot({ taskId: c.taskId, tabId: c.tabId })
            const png = decodePng(control.data)
            const serialized = JSON.stringify([obs, batch, denied.message])
            evidence('A11', { path: 'canary-frame', i, frames: obs.frames.map((f) => `${f.origin}:${f.allowed}`), cElements: obs.elements.filter((e) => e.frameOrigin === SITE_C).length, screenshot: denied.code, batchOutcome: batch.result?.outcome, controlImage: [png.width, png.height], canaryInResponses: serialized.includes('ABP-CANARY') })
            expect(serialized.includes('ABP-CANARY')).toBe(false)
            // Request-time enforcement blocks the C document itself, so the frame reports C or an undeterminable
            // origin; either way it is listed as not allowed and contributes nothing.
            const foreign = obs.frames.filter((f) => f.origin !== SITE_A)
            expect(foreign.length).toBeGreaterThan(0)
            expect(foreign.every((f) => f.allowed === false)).toBe(true)
            expect(obs.elements.filter((e) => e.frameOrigin === SITE_C)).toHaveLength(0)
            expect(batch.result?.outcome, 'screenshot step inside a batch must also be refused').not.toBe('succeeded')
            expect(png.width).toBeGreaterThan(0)
            expect(control.tabId).toBe(c.tabId)
        } finally {
            expect(await cleanupSpace(stack, agent, t.taskSpaceId, [t.taskId])).toBeUndefined()
            expect(await cleanupSpace(stack, both, c.taskSpaceId, [c.taskId])).toBeUndefined()
        }
    })

    it.each(range(N))('password and URL-query canaries never appear in observe, events, errors, journal or logs #%i', async (i) => {
        const L = ledgerRun(stack, `a11-secret-${i}`)
        const queryCanary = `qcanary${randomUUID().replace(/-/g, '')}`
        const agent = client(stack, mintAgent(stack).token)
        const ui = client(stack, mintInteractive(stack).token)
        const t = await newTaskWithPage(agent, pageUrl(stack, SITE_A, '/secret-form', { token: queryCanary }, L))
        try {
            const pwCanary = `ABP-CANARY-PW-${L}`
            const obs = await agent.observe({ taskId: t.taskId, tabId: t.tabId })
            const r = await agent.submitBatch({ taskId: t.taskId, expectedVersion: t.version, requestId: rid(), steps: [
                step(t.tabId, 'observe'),
                step(t.tabId, 'navigate', { url: pageUrl(stack, SITE_A, '/secret-form', { token: queryCanary }, L) }),
                step(t.tabId, 'click', { ref: '@e999' }),
            ] }, { waitMs: 30_000 })
            const events = await allEvents(ui, t.taskId)
            const task = await ui.getTask({ taskId: t.taskId })
            const surfaces = { observe: JSON.stringify(obs), batch: JSON.stringify(r), events: JSON.stringify(events), task: JSON.stringify(task) }
            const hits: string[] = []
            for (const [name, text] of Object.entries(surfaces)) {
                if (text.includes(pwCanary) || text.includes('ABP-CANARY')) hits.push(`${name}:password`)
                if (text.includes(queryCanary)) hits.push(`${name}:query`)
            }
            const journalPw = grepVolume(stack, 'ABP-CANARY')
            const journalQuery = grepVolume(stack, queryCanary)
            const logs = containerLogs(stack, 'runtime')
            // Locate (without printing the value) which record keys hold the query canary.
            const where = journalQuery.length ? docker(['run', '--rm', '-v', `abp-${stack.run}-state:/s:ro`, '--entrypoint', 'sh', `abp-runtime:${process.env.ABP_IMAGE_TAG ?? 'poc'}`, '-c', `grep -rhoE -- ".{0,80}$0" /s | sed "s/$0/<CANARY>/g" | head -5`, queryCanary]) : ''
            evidence('A11', { path: 'secret-canaries', i, responseHits: hits, journalPasswordFiles: journalPw.length, journalQueryFiles: journalQuery.length, logHits: [logs.includes('ABP-CANARY'), logs.includes(queryCanary)], errorCode: r.result?.steps.find((s) => s.error)?.error?.code, queryCanaryFiles: journalQuery.map((f) => f.replace(/[0-9a-f-]{36}/g, '<id>')), queryCanaryContext: where.split('\n').filter(Boolean) })
            expect(hits).toEqual([])
            expect(journalPw, 'password canary in the durable journal/state volume').toEqual([])
            expect(journalQuery, 'URL query canary in the durable journal/state volume').toEqual([])
            expect(logs.includes('ABP-CANARY') || logs.includes(queryCanary)).toBe(false)
        } finally {
            expect(await cleanupSpace(stack, agent, t.taskSpaceId, [t.taskId])).toBeUndefined()
        }
    })

    it.each(range(N))('no raw CDP / evaluate surface is reachable and the viewer requires authentication #%i', async (i) => {
        const ports: Record<string, string> = {}
        for (const name of ['browser-a', 'browser-b', 'runtime', 'fixture']) ports[name] = docker(['port', `abp-${stack.run}-${name}`]).trim().replace(/\n/g, ', ')
        const cdpExposed = Object.entries(ports).filter(([, v]) => /(^|\D)(9222|9223|9224)\/tcp/.test(v))
        const evaluateOp = await rawOp(stack, 'evaluate', { expression: '1' }, { authorization: `Bearer ${mintAgent(stack).token}` })
        const agentOps = await rawOp(stack, 'submitBatch', { taskId: 'task-x', expectedVersion: 0, requestId: rid(), steps: [{ stepId: 's', actionId: 'a', tabId: 't', kind: 'evaluate', timeoutMs: 1000 }] }, { authorization: `Bearer ${mintAgent(stack).token}` })
        const security = await vncSecurityTypes(stack.env.ports.novncA!).catch((e: Error) => [`error:${e.message}`] as unknown as number[])
        evidence('A11', { path: 'raw-surfaces', i, ports, cdpExposed: cdpExposed.length, evaluateOp: `${evaluateOp.status}:${evaluateOp.json.error?.code}`, evaluateStep: `${agentOps.status}:${agentOps.json.error?.code}`, vncSecurityTypes: security })
        expect(cdpExposed, 'no CDP / instance port may be published to the host').toEqual([])
        expect(evaluateOp.status).toBe(404)
        expect(agentOps.json.error?.code).toBe('INVALID_REQUEST')
        expect(security, 'CONTRACT: the viewer (noVNC→x11vnc) must not accept unauthenticated clients (RFB security type 1 = None)').not.toContain(1)
    })
})
