/**
 * Typed HTTP client for the Browser Runtime server. Read operations retry on
 * connection errors; mutations never auto-retry (callers reuse requestId).
 */
import {
    BrowserRuntimeError, ERROR_CODES, type BrowserRuntimeApi, type ErrorCode, type Operation, type RuntimeErrorBody, type ViewerTicket,
    type ViewerTicketRequest,
} from './contracts'

/** viewerTicket is served by the viewer proxy, not by BrowserRuntimeApi. */
type Api = BrowserRuntimeApi & { viewerTicket(auth: unknown, req: ViewerTicketRequest): Promise<ViewerTicket> }
type Req<K extends keyof Api> = Parameters<Api[K]>[1]
type Res<K extends keyof Api> = Awaited<ReturnType<Api[K]>>

const READ_OPS: ReadonlySet<Operation> = new Set(['getTask', 'observe', 'subscribe', 'screenshot'])
const READ_RETRIES = 2

export interface RuntimeClientOptions {
    baseUrl: string
    /** Token or a getter (e.g. re-read from a grant file on each call). */
    token: string | (() => string | Promise<string>)
    fetchImpl?: typeof fetch
    retryDelayMs?: number
}

export class RuntimeClient {
    private readonly fetchImpl: typeof fetch
    constructor(private readonly opts: RuntimeClientOptions) {
        this.fetchImpl = opts.fetchImpl ?? fetch
    }

    createSpace(req: Req<'createSpace'>) { return this.call('createSpace', req) }
    createTask(req: Req<'createTask'>) { return this.call('createTask', req) }
    openPage(req: Req<'openPage'>) { return this.call('openPage', req) }
    closePage(req: Req<'closePage'>) { return this.call('closePage', req) }
    observe(req: Req<'observe'>) { return this.call('observe', req) }
    screenshot(req: Req<'screenshot'>) { return this.call('screenshot', req) }
    submitBatch(req: Req<'submitBatch'>, opts?: { waitMs?: number }) {
        return this.call('submitBatch', { ...req, ...(opts?.waitMs !== undefined ? { waitMs: opts.waitMs } : {}) })
    }
    finishTask(req: Req<'finishTask'>) { return this.call('finishTask', req) }
    getTask(req: Req<'getTask'>) { return this.call('getTask', req) }
    listTasks(req: Req<'listTasks'>) { return this.call('listTasks', req) }
    subscribe(req: Req<'subscribe'>, opts?: { waitMs?: number }) {
        return this.call('subscribe', { ...req, ...(opts?.waitMs !== undefined ? { waitMs: opts.waitMs } : {}) })
    }
    approve(req: Req<'approve'>) { return this.call('approve', req) }
    takeOver(req: Req<'takeOver'>) { return this.call('takeOver', req) }
    releaseControl(req: Req<'releaseControl'>) { return this.call('releaseControl', req) }
    resume(req: Req<'resume'>) { return this.call('resume', req) }
    cancel(req: Req<'cancel'>) { return this.call('cancel', req) }
    closeSpace(req: Req<'closeSpace'>) { return this.call('closeSpace', req) }
    viewerTicket(req: Req<'viewerTicket'>) { return this.call('viewerTicket', req) }

    private async call<K extends Operation>(op: K, body: unknown): Promise<Res<K>> {
        const attempts = READ_OPS.has(op) ? READ_RETRIES + 1 : 1
        for (let attempt = 1; ; attempt++) {
            let response: Response
            try {
                const token = typeof this.opts.token === 'function' ? await this.opts.token() : this.opts.token
                response = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, '')}/v1/ops/${op}`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                    body: JSON.stringify(body),
                })
            } catch (err) {
                if (err instanceof BrowserRuntimeError) throw err
                if (attempt < attempts) {
                    await new Promise((r) => setTimeout(r, this.opts.retryDelayMs ?? 200))
                    continue
                }
                // A mutation that failed to connect may still have reached the server.
                throw new BrowserRuntimeError('RUNTIME_UNAVAILABLE', `runtime unreachable during ${op}`, true, !READ_OPS.has(op))
            }
            let json: { ok?: boolean; result?: unknown; error?: Partial<RuntimeErrorBody> }
            try {
                json = (await response.json()) as typeof json
            } catch {
                throw new BrowserRuntimeError('RUNTIME_UNAVAILABLE', `invalid response for ${op} (HTTP ${response.status})`, true, !READ_OPS.has(op))
            }
            if (json.ok === true) return json.result as Res<K>
            const e = json.error ?? {}
            const code: ErrorCode = (ERROR_CODES as readonly string[]).includes(e.code as string) ? (e.code as ErrorCode) : 'RUNTIME_UNAVAILABLE'
            throw new BrowserRuntimeError(code, e.message ?? `HTTP ${response.status}`, e.retryable ?? false, e.mayHaveSideEffects ?? false)
        }
    }
}
