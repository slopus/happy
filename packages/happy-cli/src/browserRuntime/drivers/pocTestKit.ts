/**
 * Test-only helpers for the driver PoC suites: a throwaway local Chrome, tiny
 * inline-HTML sites with a server-side click ledger, a raw "harness" CDP
 * client that plays the page/user side, and a dependency-free PNG decoder.
 *
 * Never imported by the Runtime. Uses synthetic data only; the Chrome profile
 * is a fresh temp directory removed on stop.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { CdpConnection } from './cdpConnection'

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export function findChrome(): string | undefined {
    if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
    if (existsSync(MAC_CHROME)) return MAC_CHROME
    return undefined
}

export interface LaunchedChrome {
    browserWsUrl: string
    version: string
    stop(): Promise<void>
    kill(): Promise<void>
}

export const HOST_RULES = 'MAP *.poc-one.test 127.0.0.1, MAP *.poc-two.test 127.0.0.1, MAP *.poc-three.test 127.0.0.1'

export async function launchChrome(): Promise<LaunchedChrome> {
    const binary = findChrome()
    if (!binary) throw new Error('no Chrome binary (set CHROME_PATH)')
    const userDataDir = mkdtempSync(join(tmpdir(), 'abp-driver-poc-'))
    const child: ChildProcess = spawn(binary, [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${userDataDir}`,
        '--site-per-process',
        `--host-resolver-rules=${HOST_RULES}`,
        '--no-proxy-server',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--password-store=basic',
        '--use-mock-keychain',
        '--window-size=800,600',
        'about:blank',
    ], { stdio: 'ignore' })
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))

    const portFile = join(userDataDir, 'DevToolsActivePort')
    const deadline = Date.now() + 20_000
    let content = ''
    while (Date.now() < deadline) {
        if (existsSync(portFile)) {
            content = readFileSync(portFile, 'utf8')
            if (content.split('\n').length >= 2 && content.split('\n')[1]) break
        }
        await delay(50)
    }
    const [port, path] = content.trim().split('\n')
    if (!port || !path) {
        child.kill('SIGKILL')
        throw new Error('Chrome did not publish DevToolsActivePort')
    }
    const versionInfo = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { Browser: string; webSocketDebuggerUrl: string }

    let stopped = false
    const kill = async () => {
        if (!stopped) {
            stopped = true
            child.kill('SIGKILL')
            await Promise.race([exited, delay(5_000)])
        }
    }
    return {
        browserWsUrl: versionInfo.webSocketDebuggerUrl,
        version: versionInfo.Browser,
        kill,
        async stop() {
            await kill()
            rmSync(userDataDir, { recursive: true, force: true })
        },
    }
}

export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function eventually<T>(fn: () => T | Promise<T>, ok: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    let value = await fn()
    while (!ok(value) && Date.now() < deadline) {
        await delay(50)
        value = await fn()
    }
    return value
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export type Route = string | { status: number; headers: Record<string, string>; body?: string }

export interface Site {
    host: string
    port: number
    origin: string
    url(path: string): string
    /** Server-side click ledger: `/hit/<name>` increments `<name>`. */
    hits(name: string): number
    resetHits(): void
    route(path: string, handler: Route | ((site: Site) => Route)): void
    close(): Promise<void>
}

/** Buttons call `hit('<name>')` which records on the serving site's ledger. */
export const HIT_SCRIPT = `<script>function hit(n){fetch('/hit/'+n,{method:'POST'})}</script>`

export async function startSite(host: string): Promise<Site> {
    const routes = new Map<string, Route | ((site: Site) => Route)>()
    const ledger = new Map<string, number>()
    const server = http.createServer((req, res) => {
        const path = (req.url ?? '/').split('?')[0]
        if (path.startsWith('/hit/')) {
            const name = path.slice('/hit/'.length)
            ledger.set(name, (ledger.get(name) ?? 0) + 1)
            res.writeHead(204).end()
            return
        }
        const entry = routes.get(path)
        if (!entry) {
            res.writeHead(404).end('not found')
            return
        }
        const route = typeof entry === 'function' ? entry(site) : entry
        if (typeof route === 'string') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(route)
        } else {
            res.writeHead(route.status, route.headers).end(route.body ?? '')
        }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const site: Site = {
        host,
        port,
        origin: `http://${host}:${port}`,
        url: (path) => `http://${host}:${port}${path}`,
        hits: (name) => ledger.get(name) ?? 0,
        resetHits: () => ledger.clear(),
        route: (path, handler) => { routes.set(path, handler) },
        close: () => new Promise((resolve) => {
            server.closeAllConnections()
            server.close(() => resolve())
        }),
    }
    return site
}

// ---------------------------------------------------------------------------
// Harness CDP: plays the page / user. Separate connection from the driver.
// ---------------------------------------------------------------------------

export class HarnessCdp {
    private constructor(readonly conn: CdpConnection) {}

    static async connect(browserWsUrl: string): Promise<HarnessCdp> {
        return new HarnessCdp(await CdpConnection.connect(browserWsUrl))
    }

    async targets(): Promise<Array<{ targetId: string; type: string; url: string; openerId?: string }>> {
        const { targetInfos } = await this.conn.send('Target.getTargets')
        return targetInfos
    }

    /** Evaluate in the page main world of a top-level target (test manipulation only). */
    async evaluate(targetId: string, expression: string): Promise<any> {
        const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId, flatten: true })
        try {
            const result = await this.conn.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
            if (result.exceptionDetails) throw new Error(`harness evaluate failed: ${result.exceptionDetails.text}`)
            return result.result?.value
        } finally {
            await this.conn.send('Target.detachFromTarget', { sessionId }).catch(() => undefined)
        }
    }

    async openFrontTab(url: string): Promise<string> {
        const { targetId } = await this.conn.send('Target.createTarget', { url })
        await this.conn.send('Target.activateTarget', { targetId })
        return targetId
    }

    async closeTarget(targetId: string): Promise<void> {
        await this.conn.send('Target.closeTarget', { targetId }).catch(() => undefined)
    }

    close(): void {
        this.conn.close()
    }
}

// ---------------------------------------------------------------------------
// PNG (8-bit RGB/RGBA, non-interlaced — what Chrome emits)
// ---------------------------------------------------------------------------

export interface DecodedPng {
    width: number
    height: number
    pixel(x: number, y: number): [number, number, number]
}

export function decodePng(base64: string): DecodedPng {
    const buf = Buffer.from(base64, 'base64')
    let offset = 8
    let width = 0
    let height = 0
    let colorType = 0
    const idat: Buffer[] = []
    while (offset < buf.length) {
        const length = buf.readUInt32BE(offset)
        const type = buf.toString('ascii', offset + 4, offset + 8)
        const data = buf.subarray(offset + 8, offset + 8 + length)
        if (type === 'IHDR') {
            width = data.readUInt32BE(0)
            height = data.readUInt32BE(4)
            if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG')
            colorType = data[9]
        } else if (type === 'IDAT') {
            idat.push(data)
        } else if (type === 'IEND') {
            break
        }
        offset += 12 + length
    }
    const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
    if (!bpp) throw new Error(`unsupported PNG color type ${colorType}`)
    const raw = inflateSync(Buffer.concat(idat))
    const stride = width * bpp
    const out = Buffer.alloc(stride * height)
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)]
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? out[y * stride + x - bpp] : 0
            const b = y > 0 ? out[(y - 1) * stride + x] : 0
            const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0
            let value = line[x]
            if (filter === 1) value += a
            else if (filter === 2) value += b
            else if (filter === 3) value += (a + b) >> 1
            else if (filter === 4) {
                const p = a + b - c
                const pa = Math.abs(p - a)
                const pb = Math.abs(p - b)
                const pc = Math.abs(p - c)
                value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
            }
            out[y * stride + x] = value & 0xff
        }
    }
    return {
        width,
        height,
        pixel: (x, y) => {
            const i = y * stride + x * bpp
            return [out[i], out[i + 1], out[i + 2]]
        },
    }
}
