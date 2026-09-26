import { afterAll, beforeAll, expect, test } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

const dir = mkdtempSync(join(tmpdir(), 'abp-fixture-'))
let child: ChildProcess
let page: string
let control: string
const token = 'synthetic-harness-token'
async function port() { return await new Promise<number>(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) }) }) }
async function req(url: string, method = 'GET', body?: unknown, auth = false) { return fetch(url, { method, headers: { ...(auth ? { 'x-harness-token': token } : {}), ...(body ? { 'content-type': 'application/json' } : {}), host: 'a.poc-one.test' }, body: body ? JSON.stringify(body) : undefined }) }
beforeAll(async () => { const p = await port(), c = await port(); page = `http://127.0.0.1:${p}`; control = `http://127.0.0.1:${c}`; child = spawn(process.execPath, ['scripts/browser-poc/fixture/server.mjs'], { env: { ...process.env, FIXTURE_PORT: String(p), CONTROL_PORT: String(c), HARNESS_TOKEN: token, LEDGER_FILE: join(dir, 'ledger.jsonl') }, stdio: 'ignore' }); for (let i = 0; i < 100; i++) { try { if ((await req(control + '/control/health', 'GET', undefined, true)).ok) return } catch {} await new Promise(r => setTimeout(r, 20)) } throw new Error('fixture did not start') })
afterAll(() => { child?.kill(); rmSync(dir, { recursive: true, force: true }) })
test('control requires token and page cannot access control', async () => { expect((await req(control + '/control/ledger?run=x')).status).toBe(401); expect((await req(page + '/control/barrier/release', 'POST', { run: 'x', key: 'k', nonce: 'n' })).status).toBe(404); expect((await req(page + '/control/ledger?run=x')).status).toBe(404) })
test('barrier release and answer correctness are ledgered', async () => { const run = 'answer'; expect((await req(page + '/api/barrier-state?run=answer&key=k')).status).toBe(200); expect((await req(control + '/control/barrier/release', 'POST', { run, key: 'k', nonce: 'n' }, true)).status).toBe(200); await req(page + '/api/answer', 'POST', { run, key: 'k', answer: 'n' }); await req(page + '/api/answer', 'POST', { run, key: 'k', answer: 'bad' }); const { entries } = await (await req(control + '/control/ledger?run=answer', 'GET', undefined, true)).json(); expect(entries.map((x: any) => [x.kind, x.correct])).toEqual([['barrier-release', undefined], ['answer', true], ['answer', false]]) })
test('duplicate risky submissions all count; drop records without response', async () => { const run = 'risky'; await req(page + '/api/risky', 'POST', { run, amount: '2', requestId: 'same' }); await req(page + '/api/risky', 'POST', { run, amount: '2', requestId: 'same' }); await req(control + '/control/fault', 'POST', { kind: 'risky', mode: 'drop-after-record', run }, true); await expect(req(page + '/api/risky', 'POST', { run, amount: '2', requestId: 'same' })).rejects.toThrow(); const { entries } = await (await req(control + '/control/ledger?run=risky', 'GET', undefined, true)).json(); expect(entries.filter((x: any) => x.kind === 'risky')).toHaveLength(3) })
test('inline click handlers stay inside their HTML attribute', async () => {
    // A raw JSON string in onclick="..." ends the attribute early, so the real button never records a click.
    for (const path of ['/oopif?run=attr', '/spa?run=attr']) {
        const body = await (await req(page + path)).text()
        const handlers = [...body.matchAll(/onclick="([^"]*)"/g)].map((match) => match[1])
        expect(handlers.length).toBeGreaterThan(0)
        for (const handler of handlers) expect(handler).toContain('target:')
    }
})
test('every inline page script is valid JavaScript', async () => {
    // A syntax error leaves the page blank, which a browser test would misread as missing state.
    const pages = ['/storage-check', '/barrier?run=s&key=k', '/oopif?run=s', '/spa?run=s', '/risky-submit?run=s', '/secret-form?token=x', '/beforeunload', '/popup', '/challenge?next=/challenge-protected', '/login?next=/protected']
    for (const path of pages) {
        const body = await (await req(page + path)).text()
        for (const match of body.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
            expect(() => new Function(match[1]), `${path} script`).not.toThrow()
        }
    }
})
test('risky submit page shows a confirmation only after the server accepted the write', async () => {
    const body = await (await req(page + '/risky-submit?run=confirm')).text()
    // The text appears from the response handler, so a lost or held response never looks confirmed.
    expect(body).toContain('.then(r=>r.json()).then(()=>{')
    expect(body.indexOf('PAYMENT RECORDED')).toBeGreaterThan(body.indexOf("fetch('/api/risky'"))
})
