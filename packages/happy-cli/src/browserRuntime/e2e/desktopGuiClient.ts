/**
 * Harness-only driver for the real Saycode Desktop GUI (client C), over the
 * renderer's CDP port of a dev build started with `--remoteDebuggingPort`.
 * It types into the same composer a user would and quits/relaunches the whole
 * Desktop process tree, so "the client is gone" is a process-level fact.
 *
 * Env: ABP_DESKTOP_DIR (Desktop worktree), ABP_DESKTOP_USER_DATA_DIR,
 * ABP_DESKTOP_CDP_PORT (default 9444).
 */
import { execFile, spawn } from 'node:child_process'
import { openSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { connect as netConnect, type Socket } from 'node:net'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const desktopDir = () => process.env.ABP_DESKTOP_DIR ?? '/Users/justin/workspace/aplus-dev-studio-desktop/.aplus/worktrees/abp-desktop'
const cdpPort = () => Number(process.env.ABP_DESKTOP_CDP_PORT ?? 9444)

export class DesktopGui {
    private id = 0
    private readonly pending = new Map<number, (message: { result?: any; error?: unknown }) => void>()

    private constructor(private readonly ws: WebSocket) {
        ws.onmessage = (event) => {
            const message = JSON.parse(String(event.data))
            if (message.id && this.pending.has(message.id)) {
                this.pending.get(message.id)!(message)
                this.pending.delete(message.id)
            }
        }
    }

    /** Attach to the Desktop renderer, waiting for a (re)launched app to come up. */
    static async connect(timeoutMs = 180_000): Promise<DesktopGui> {
        for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(1_000)) {
            const targets = await fetch(`http://127.0.0.1:${cdpPort()}/json/list`).then((r) => r.json() as Promise<Array<{ type: string; url: string; webSocketDebuggerUrl: string }>>).catch(() => [])
            const page = targets.find((target) => target.type === 'page' && /^http:\/\/(localhost|127\.0\.0\.1):/.test(target.url))
            if (!page) continue
            const ws = new WebSocket(page.webSocketDebuggerUrl)
            await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
            return new DesktopGui(ws)
        }
        throw new Error('Desktop renderer did not come up')
    }

    private send(method: string, params: Record<string, unknown> = {}): Promise<{ result?: any; error?: unknown }> {
        const id = ++this.id
        return new Promise((resolve) => {
            this.pending.set(id, resolve)
            this.ws.send(JSON.stringify({ id, method, params }))
        })
    }

    async eval<T>(expression: string): Promise<T> {
        const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
        return response.result?.result?.value as T
    }

    async waitFor(expression: string, timeoutMs: number): Promise<boolean> {
        for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(500)) {
            if (await this.eval<boolean>(`Boolean(${expression})`)) return true
        }
        return false
    }

    async screenshot(path: string): Promise<void> {
        const response = await this.send('Page.captureScreenshot', { format: 'png' })
        writeFileSync(path, Buffer.from(response.result.data, 'base64'))
    }

    async clickButton(text: string): Promise<boolean> {
        return this.eval<boolean>(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.offsetParent&&b.textContent.trim()===${JSON.stringify(text)}); b?.click(); return !!b})()`)
    }

    /** Type into the visible composer the way a user does (focused textarea + text input). */
    async typeInComposer(text: string): Promise<void> {
        const focused = await this.eval<boolean>(`(()=>{const e=[...document.querySelectorAll('textarea[aria-label="메시지"]:not([disabled]), textarea:not([disabled])')].filter(e=>e.offsetParent).at(-1); if(!e) return false; e.focus(); return document.activeElement===e})()`)
        if (!focused) throw new Error('no enabled composer')
        await this.send('Input.insertText', { text })
    }

    async clickSend(): Promise<void> {
        // After a turn ends the composer stays in "전송 중..." for a few seconds; a user waits for it.
        await this.waitFor(`[...document.querySelectorAll('button.composer-send')].some(b=>b.offsetParent&&!b.disabled)`, 120_000)
        const ok = await this.eval<boolean>(`(()=>{const b=[...document.querySelectorAll('button.composer-send')].filter(b=>b.offsetParent&&!b.disabled).at(-1); b?.click(); return !!b})()`)
        if (!ok) throw new Error('send button unavailable')
    }

    /** "내 채팅" landing → pick the execution machine → first message. */
    async startPersonalChat(machineIdPrefix: string, text: string): Promise<void> {
        // A freshly launched app may ignore the first click: keep navigating until the machine picker shows.
        const offered = `[...document.querySelectorAll('select')].some(s=>[...s.options].some(o=>o.value.startsWith(${JSON.stringify(machineIdPrefix)})))`
        let picked = false
        for (const deadline = Date.now() + 90_000; !picked && Date.now() < deadline;) {
            await this.eval(`(()=>{const b=[...document.querySelectorAll('button,a')].find(b=>b.offsetParent&&b.textContent.trim()==='내 채팅'); b?.click()})()`)
            picked = await this.waitFor(offered, 5_000)
        }
        if (!picked) throw new Error(`machine ${machineIdPrefix} is not offered by the Desktop`)
        await this.eval(`(()=>{const s=[...document.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value.startsWith(${JSON.stringify(machineIdPrefix)}))); const o=[...s.options].find(o=>o.value.startsWith(${JSON.stringify(machineIdPrefix)})); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,o.value); s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
        await this.typeInComposer(text)
        await this.clickSend()
    }

    /** Send in the chat that is open now; resolves once the composer accepted it (draft cleared). */
    async sendInOpenChat(text: string): Promise<void> {
        await this.typeInComposer(text)
        await this.clickSend()
        if (!await this.waitFor(`![...document.querySelectorAll('textarea')].some(e=>e.offsetParent&&e.value.includes(${JSON.stringify(text.slice(0, 40))}))`, 30_000)) {
            throw new Error('Desktop did not accept the message')
        }
    }

    async openPersonalChatByTitle(titlePrefix: string): Promise<boolean> {
        await this.eval(`(()=>{const b=[...document.querySelectorAll('button,a')].find(b=>b.offsetParent&&b.textContent.trim()==='내 채팅'); b?.click()})()`)
        const found = await this.waitFor(`[...document.querySelectorAll('button,a,[role=button]')].some(e=>e.offsetParent&&e.textContent.trim().startsWith(${JSON.stringify(titlePrefix)}))`, 60_000)
        if (!found) return false
        await this.eval(`(()=>{const e=[...document.querySelectorAll('button,a,[role=button]')].find(e=>e.offsetParent&&e.textContent.trim().startsWith(${JSON.stringify(titlePrefix)})); e.click()})()`)
        return true
    }

    async bodyText(): Promise<string> {
        return this.eval<string>('document.body.innerText')
    }

    close(): void {
        this.ws.close()
    }
}

/** Every process of this Desktop build (dev server, Electron main/helpers, native helpers). */
export async function desktopProcesses(): Promise<Array<{ pid: number; command: string }>> {
    const { stdout } = await execFileAsync('pgrep', ['-fl', desktopDir()]).catch(() => ({ stdout: '' }))
    return stdout.trim() ? stdout.trim().split('\n').map((line) => {
        const [pid, ...rest] = line.split(' ')
        return { pid: Number(pid), command: rest.join(' ').replace(desktopDir(), '<desktop>').slice(0, 120) }
    }) : []
}

/**
 * Quit the whole Desktop client: SIGTERM first (the app's own quit path), SIGKILL
 * whatever is still alive after the grace period, then prove nothing is left.
 */
export async function quitDesktop(graceMs = 10_000): Promise<{ before: Array<{ pid: number; command: string }>; killedAfterGrace: number; remaining: number }> {
    const before = await desktopProcesses()
    for (const { pid } of before) try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
    for (const deadline = Date.now() + graceMs; Date.now() < deadline && (await desktopProcesses()).length > 0;) await sleep(500)
    const survivors = await desktopProcesses()
    for (const { pid } of survivors) try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    await sleep(1_000)
    return { before, killedAfterGrace: survivors.length, remaining: (await desktopProcesses()).length }
}

/** "Sleep" of the client PC, simulated for the Desktop only: stop (and later continue) its whole process tree. */
export async function signalDesktop(signal: 'SIGSTOP' | 'SIGCONT'): Promise<{ processes: number; states: string[] }> {
    const processes = await desktopProcesses()
    for (const { pid } of processes) try { process.kill(pid, signal) } catch { /* gone */ }
    await sleep(500)
    const { stdout } = await execFileAsync('ps', ['-o', 'stat=', '-p', processes.map((p) => p.pid).join(',')]).catch(() => ({ stdout: '' }))
    return { processes: processes.length, states: stdout.trim().split('\n').map((line) => line.trim()[0]).filter(Boolean) }
}

/**
 * Client-only network cut: Desktop is launched with --proxy-server pointing here. cut() destroys
 * every tunnelled connection and refuses new ones; restore() lets traffic through again. Covers
 * Chromium's network stack (renderer API, realtime socket); node-side helpers of the app bypass it.
 */
export async function startClientProxy(): Promise<{ port: number; cut(): number; restore(): void; stats(): { tunnels: number; refused: number }; close(): Promise<void> }> {
    const sockets = new Set<Socket>()
    let blocked = false
    let tunnels = 0
    let refused = 0
    const track = (socket: Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) }
    const server: Server = createServer((req, res) => {
        if (blocked) { refused++; req.socket.destroy(); return }
        const upstream = httpRequest(req.url ?? '', { method: req.method, headers: req.headers }, (answer) => { res.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(res) })
        upstream.on('error', () => res.destroy())
        req.pipe(upstream)
    })
    server.on('connection', track)
    server.on('connect', (req, client: Socket, head) => {
        if (blocked) { refused++; client.destroy(); return }
        const [host, port] = String(req.url).split(':')
        const upstream = netConnect(Number(port) || 443, host, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); upstream.write(head); upstream.pipe(client); client.pipe(upstream) })
        tunnels++
        track(upstream)
        upstream.on('error', () => client.destroy())
        client.on('error', () => upstream.destroy())
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    return {
        port,
        cut: () => { blocked = true; const n = sockets.size; for (const socket of sockets) socket.destroy(); return n },
        restore: () => { blocked = false },
        stats: () => ({ tunnels, refused }),
        close: () => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()) }),
    }
}

/** Relaunch the same Desktop build with the same user data (the user reopening the app). */
export function launchDesktop(logFile: string, options: { proxyPort?: number } = {}): void {
    const out = openSync(logFile, 'a')
    const env = { ...process.env }
    for (const key of ['SAYCODE_AGENT_ENV', 'SAYCODE_AGENT_ROOT', 'HAPPY_HOME_DIR', 'ELECTRON_RUN_AS_NODE']) delete env[key]
    if (process.env.ABP_DESKTOP_USER_DATA_DIR) env.APLUS_DESKTOP_USER_DATA_DIR = process.env.ABP_DESKTOP_USER_DATA_DIR
    const extra = options.proxyPort ? ['--', `--proxy-server=http://127.0.0.1:${options.proxyPort}`] : []
    // ABP_DESKTOP_VITE_CONFIG pins the renderer dev server (another project's dev server on the same
    // default port would otherwise be loaded into this window).
    const config = process.env.ABP_DESKTOP_VITE_CONFIG ? ['-c', process.env.ABP_DESKTOP_VITE_CONFIG] : []
    const child = spawn('npx', ['electron-vite', 'dev', ...config, '--remoteDebuggingPort', String(cdpPort()), ...extra], { cwd: desktopDir(), env, detached: true, stdio: ['ignore', out, out] })
    child.unref()
}
