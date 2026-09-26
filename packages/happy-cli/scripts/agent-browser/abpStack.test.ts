import { createHash, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createStack } from './abp-stack.mjs'
import { mergeInstallOptions, PATHS } from './lib/abpPlan.mjs'

const RUNTIME_OLD = 'sha256:' + 'a'.repeat(64)
const BROWSER_OLD = 'sha256:' + 'b'.repeat(64)
const RUNTIME_NEW = 'sha256:' + 'c'.repeat(64)
const BROWSER_NEW = 'sha256:' + 'd'.repeat(64)
const FIREWALL = '/usr/local/libexec/abp/abp-firewall'
const FENCE = 'iptables -w -t filter -A ABP-FENCE -p tcp -m tcp --dport 38700 -j REJECT --reject-with tcp-reset'
const UNFENCE = 'iptables -w -t filter -F ABP-FENCE'
const LABEL = 'docker inspect -f {{index .Config.Labels "ai.saycode.abp.image"}} abp-runtime'

type Result = { status: number; stdout: string; stderr: string }
type Handler = (args: string[]) => Partial<Result> | undefined
interface HostOptions {
    current?: { runtime: string; browser: string } | null
    previous?: { runtime: string; browser: string } | null
    handlers?: Array<[RegExp, Handler]>
    /** tasks.running per admin metrics call (drain); undefined = Runtime unreachable */
    running?: Array<number | undefined>
    /** whether `docker inspect` reports the Runtime running (controlled operations) */
    runtimeRunning?: boolean
    /** abp-stack.service is active: upgrades replace only the containers whose digest changes */
    serviceActive?: boolean
    profiles?: Array<{ profileId: string; principalId: string }>
}

/**
 * Records every command; files live in a map. Docker is modelled per container (running, image label):
 * create/start/stop/kill/rm act on it, and the abp-stack.service start/stop recreate or stop the whole
 * stack from the state file, as abp-stack run would. Side effects apply only to commands that succeed.
 */
function fakeHost(options: HostOptions = {}) {
    const calls: string[] = []
    const logs: string[] = []
    const files = new Map<string, { data: string; mode: number; owner: string; group: string }>()
    const install = {
        ...mergeInstallOptions(undefined, {
            machineId: 'machine-1', workspaceId: 'ws-1',
            profiles: [{ profileId: 'main', principalId: 'user-1' }],
            issuers: [{ kid: 'k1', publicKeyPem: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
        }),
        // Two profiles exercise the per-profile loops; release 1 installs only main (see the set-principal test).
        profiles: options.profiles ?? [{ profileId: 'main', principalId: 'user-1' }, { profileId: 'ops', principalId: 'user-2' }],
    }
    files.set(PATHS.installConfig, { data: JSON.stringify(install), mode: 0o600, owner: 'root', group: 'root' })
    files.set(PATHS.runtimeConfig, { data: JSON.stringify({ daemonTokenSha256: 'e'.repeat(64) }), mode: 0o600, owner: 'root', group: 'root' })
    files.set(PATHS.stackState, { data: JSON.stringify({ schemaVersion: 1, current: options.current === undefined ? { runtime: RUNTIME_OLD, browser: BROWSER_OLD } : options.current, previous: options.previous ?? null, history: [] }), mode: 0o600, owner: 'root', group: 'root' })
    const state = () => JSON.parse(files.get(PATHS.stackState)!.data)
    const running = [...(options.running ?? [])]
    const names = ['abp-runtime', ...install.profiles.map((profile: { profileId: string }) => `abp-browser-${profile.profileId}`)]
    const containers = new Map<string, { running: boolean; image: string }>()
    const recreateAll = (up: boolean) => {
        const current = state().current ?? { runtime: '', browser: '' }
        for (const name of names) containers.set(name, { running: up, image: name === 'abp-runtime' ? current.runtime : current.browser })
    }
    recreateAll(true)
    containers.get('abp-runtime')!.running = options.runtimeRunning ?? true
    let lockHeld = false
    // The fence resets host packets to the API port: while it is up, the Runtime does not answer.
    let fenced = false
    let secretCount = 0
    const deps = {
        run(cmd: string, args: string[], opts: { allowFail?: boolean } = {}): Result {
            const line = [cmd, ...args].join(' ')
            calls.push(line)
            const handlers: Array<[RegExp, Handler]> = [
                ...options.handlers ?? [],
                [/^systemctl is-active abp-stack\.service$/, () => (options.serviceActive ? { stdout: 'active' } : { status: 3, stdout: 'inactive' })],
                [/^docker image inspect/, (a) => ({ stdout: a.at(-1) })],
                [/^docker inspect -f \{\{\.State\.Running\}\} (\S+)$/, (a) => ({ stdout: String(containers.get(a.at(-1)!)?.running ?? false) })],
                [/^docker inspect -f \{\{\.State\.Running\}\} \{\{index \.Config\.Labels "ai\.saycode\.abp\.image"\}\} (\S+)$/, (a) => {
                    const container = containers.get(a.at(-1)!)
                    return container ? { stdout: `${container.running} ${container.image}` } : { status: 1 }
                }],
                [new RegExp(`^${LABEL.replace(/[{}.]/g, '\\$&')}$`), () => ({ stdout: containers.get('abp-runtime')?.image ?? '' })],
            ]
            let result: Result = { status: 0, stdout: '', stderr: '' }
            for (const [pattern, handler] of handlers) {
                if (pattern.test(line)) { result = { status: 0, stdout: '', stderr: '', ...handler(args) }; break }
            }
            if (result.status === 0) {
                if (line === FENCE) fenced = true
                if (line === UNFENCE) fenced = false
                // abp-stack.service: its stop takes the stack down; its start recreates it and lifts the fence.
                if (line === 'systemctl stop abp-stack.service') for (const container of containers.values()) container.running = false
                if (line === 'systemctl start abp-stack.service') { recreateAll(true); fenced = false }
                const name = args.at(-1)!
                if (cmd === 'docker' && args[0] === 'create') containers.set(args[1].replace('--name=', ''), { running: false, image: name })
                if (cmd === 'docker' && args[0] === 'start' && containers.has(name)) containers.get(name)!.running = true
                if (cmd === 'docker' && ['stop', 'kill'].includes(args[0]) && containers.has(name)) containers.get(name)!.running = false
                if (cmd === 'docker' && args[0] === 'restart' && containers.has(name)) containers.get(name)!.running = true
                if (cmd === 'docker' && args[0] === 'rm') for (const id of args.slice(2)) containers.delete(id)
            }
            if (result.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args[0]} failed`)
            return result
        },
        readFile(path: string) {
            const file = files.get(path)
            if (!file) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
            return file.data
        },
        exists: (path: string) => files.has(path),
        writeFileAtomic(path: string, data: string, meta: { mode: number; owner: string; group: string }) { files.set(path, { data, ...meta }) },
        remove(path: string) { files.delete(path) },
        groupId: (name: string) => (name === 'abp-session' ? 990 : 1),
        async ready() { return { status: fenced ? 0 : 200, body: {} } },
        async adminMetrics() {
            const value = running.length ? running.shift() : 0
            return value === undefined ? undefined : { tasks: { running: value } }
        },
        async brokerProbe(token: string) { return token === JSON.parse(files.get(PATHS.runtimeConfig)!.data).probeToken ? 401 : 200 },
        async sleep() {},
        now: () => 1_000_000,
        log: (line: string) => { logs.push(line) },
        secret: (kind: string) => `synthetic-${kind}-${++secretCount}`.padEnd(kind === 'vnc-password' ? 0 : 40, 'x').slice(0, kind === 'vnc-password' ? 8 : 64),
        async opLock() {
            if (lockHeld) throw new Error('another abp-stack operation is running')
            lockHeld = true
            return () => { lockHeld = false }
        },
    }
    return { deps, calls, logs, files, state, containers }
}

const indexOf = (calls: string[], pattern: RegExp | string) => calls.findIndex((line) => (typeof pattern === 'string' ? line === pattern : pattern.test(line)))

describe('abp-stack start', () => {
    it('requires the browser egress firewall, recreates mismatched networks, starts browsers before the Runtime at fixed addresses, then lifts the fence', async () => {
        const host = fakeHost({ handlers: [
            [/^docker network inspect -f .* abp-net-main$/, () => ({ stdout: '10.249.240.0/24 10.249.240.1 br-abp-wrong' })],
            [/^docker network inspect -f .* abp-net-ops$/, () => ({ status: 1 })],
            [/^docker volume inspect abp-profile-ops/, () => ({ status: 1 })],
            [/^docker ps -aq --filter label=ai.saycode.abp=stack/, () => ({ stdout: 'old1\nold2' })],
        ] })
        await createStack(host.deps).start()
        const { calls } = host
        expect(calls[0]).toBe(`${FIREWALL} check-egress`)
        const removeOld = indexOf(calls, 'docker rm -f old1 old2')
        // Containers go before their networks can be replaced.
        expect(indexOf(calls, 'docker network rm abp-net-main')).toBeGreaterThan(removeOld)
        expect(indexOf(calls, /^docker network create .*--subnet=10\.249\.240\.0\/24 .*abp-net-main$/)).toBeGreaterThan(indexOf(calls, 'docker network rm abp-net-main'))
        expect(indexOf(calls, /^docker network create .*--subnet=10\.249\.241\.0\/24 .*abp-net-ops$/)).toBeGreaterThan(removeOld)
        expect(calls).toContain('docker volume create --label=ai.saycode.abp=stack abp-profile-ops')
        const browserCreate = indexOf(calls, /^docker create --name=abp-browser-main .*--ip=10\.249\.240\.2 .*sha256:b{64}$/)
        const runtimeCreate = indexOf(calls, /^docker create --name=abp-runtime .*--ip=10\.249\.240\.3 .*sha256:a{64}$/)
        expect(browserCreate).toBeGreaterThan(removeOld)
        expect(runtimeCreate).toBeGreaterThan(browserCreate)
        expect(calls).toContain('docker network connect --alias=runtime --ip=10.249.241.3 abp-net-ops abp-runtime')
        expect(indexOf(calls, UNFENCE)).toBeGreaterThan(indexOf(calls, 'docker start abp-runtime'))
        expect(calls.some((line) => /volume rm|--no-sandbox/.test(line))).toBe(false)
    })

    it('re-applies a missing egress firewall, and refuses to start any container when it cannot', async () => {
        let applied = false
        const repaired = fakeHost({ handlers: [
            [/check-egress$/, () => ({ status: applied ? 0 : 1 })],
            [/apply-egress$/, () => { applied = true; return {} }],
        ] })
        await createStack(repaired.deps).start()
        expect(repaired.calls.slice(0, 3)).toEqual([`${FIREWALL} check-egress`, `${FIREWALL} apply-egress`, `${FIREWALL} check-egress`])
        expect(repaired.logs.join('\n')).toMatch(/egress firewall missing or changed; re-applying/)
        const broken = fakeHost({ handlers: [[/check-egress$/, () => ({ status: 1 })]] })
        await expect(createStack(broken.deps).start()).rejects.toThrow(/egress firewall/)
        expect(broken.calls.some((line) => line.startsWith('docker create') || line.startsWith('docker start'))).toBe(false)
    })

    it('refuses to start without installed images', async () => {
        const host = fakeHost({ current: null })
        await expect(createStack(host.deps).start()).rejects.toThrow(/no images/)
    })
})

describe('abp-stack stop (admission fence, drain, verified stop)', () => {
    it('fences the Runtime API, waits for running batches, stops Runtime then browsers and verifies they are down', async () => {
        const host = fakeHost({ running: [2, 1, 0], runtimeRunning: false })
        await createStack(host.deps).stop()
        const { calls } = host
        expect(calls.slice(0, 2)).toEqual([UNFENCE, FENCE])
        const stopRuntime = indexOf(calls, 'docker stop -t 30 abp-runtime')
        expect(stopRuntime).toBeGreaterThan(1)
        expect(host.logs.join('\n')).toMatch(/draining: 2 running/)
        expect(indexOf(calls, 'docker stop -t 10 abp-browser-main')).toBeGreaterThan(stopRuntime)
        expect(calls).toContain('docker inspect -f {{.State.Running}} abp-runtime')
        expect(calls.some((line) => line.startsWith('docker kill'))).toBe(false)
    })

    it('stops anyway after the drain timeout (tasks then recover paused) and kills a container that does not stop', async () => {
        let killed = false
        const host = fakeHost({ running: Array(200).fill(1), runtimeRunning: false, handlers: [
            [/^docker inspect -f \{\{\.State\.Running\}\} abp-browser-ops$/, () => ({ stdout: killed ? 'false' : 'true' })],
            [/^docker kill abp-browser-ops$/, () => { killed = true; return {} }],
        ] })
        let clock = 0
        host.deps.now = () => (clock += 1_000)
        await createStack(host.deps).stop({ drainMs: 10_000 })
        expect(host.logs.join('\n')).toMatch(/drain timeout with 1 running task\(s\); they recover paused/)
        expect(host.calls).toContain('docker kill abp-browser-ops')
    })

    it('fails loudly when a container survives the kill', async () => {
        const host = fakeHost({ handlers: [[/^docker inspect -f \{\{\.State\.Running\}\} abp-runtime$/, () => ({ stdout: 'true' })]] })
        await expect(createStack(host.deps).stop()).rejects.toThrow(/abp-runtime is still running/)
    })
})

describe('abp-stack emergency-stop', () => {
    it('stops at once without draining or the operations lock, and verifies the containers are down', async () => {
        const host = fakeHost({ running: Array(100).fill(3), runtimeRunning: false })
        const release = await host.deps.opLock()
        let metricsCalls = 0
        host.deps.adminMetrics = async () => { metricsCalls++; return { tasks: { running: 3 } } }
        await createStack(host.deps).emergencyStop()
        expect(metricsCalls).toBe(0)
        expect(host.files.has('/run/abp-stack-emergency')).toBe(true)
        const stopService = host.calls.indexOf('systemctl stop abp-stack.service')
        expect(stopService).toBeGreaterThan(host.calls.indexOf(FENCE))
        expect(indexOf(host.calls, 'docker stop -t 10 abp-runtime')).toBeGreaterThan(stopService)
        expect(host.calls).toContain('docker inspect -f {{.State.Running}} abp-browser-ops')
        release()
    })

    it('makes the service stop skip the drain while the emergency flag is set, and start clears it', async () => {
        const host = fakeHost({ running: Array(100).fill(3), runtimeRunning: false })
        host.files.set('/run/abp-stack-emergency', { data: '', mode: 0o600, owner: 'root', group: 'root' })
        let metricsCalls = 0
        host.deps.adminMetrics = async () => { metricsCalls++; return { tasks: { running: 3 } } }
        await createStack(host.deps).stop()
        expect(metricsCalls).toBe(0)
        host.deps.remove = (path: string) => { host.files.delete(path) }
        await createStack(host.deps).start()
        expect(host.files.has('/run/abp-stack-emergency')).toBe(false)
    })
})

describe('abp-stack supervise', () => {
    it('restarts an exited container only after its backoff, and logs the exit code', () => {
        let now = 0
        const host = fakeHost({ handlers: [
            [/^docker inspect -f \{\{\.State\.Running\}\} \{\{\.State\.ExitCode\}\} abp-runtime$/, () => ({ stdout: 'false 75' })],
            [/^docker inspect -f \{\{\.State\.Running\}\} \{\{\.State\.ExitCode\}\} abp-browser-/, () => ({ stdout: 'true 0' })],
        ] })
        host.deps.now = () => now
        const stack = createStack(host.deps)
        const backoff = new Map()
        stack.superviseOnce(backoff)
        expect(host.calls.filter((line) => line === 'docker start abp-runtime')).toHaveLength(1)
        expect(host.logs.join('\n')).toMatch(/abp-runtime exited status=75/)
        now = 500
        stack.superviseOnce(backoff)
        expect(host.calls.filter((line) => line === 'docker start abp-runtime')).toHaveLength(1)
        now = 5_000
        stack.superviseOnce(backoff)
        expect(host.calls.filter((line) => line === 'docker start abp-runtime')).toHaveLength(2)
        expect(host.calls.some((line) => line.startsWith('docker start abp-browser'))).toBe(false)
    })

    it('stops the browsers and restarts nothing while the egress firewall is missing', () => {
        const host = fakeHost({ handlers: [
            [/check-egress$|apply-egress$/, () => ({ status: 1 })],
            [/^docker inspect -f \{\{\.State\.Running\}\} \{\{\.State\.ExitCode\}\}/, () => ({ stdout: 'false 1' })],
        ] })
        createStack(host.deps).superviseOnce(new Map())
        expect(host.calls).toContain('docker stop -t 10 abp-browser-main')
        expect(host.calls.some((line) => line.startsWith('docker start'))).toBe(false)
        expect(host.logs.join('\n')).toMatch(/egress firewall/)
    })
})

describe('abp-stack upgrade / rollback', () => {
    it('stops the stack, switches to the new digests, waits for /v1/ready and keeps the old digests for rollback', async () => {
        const host = fakeHost()
        await createStack(host.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_NEW }, readyTimeoutMs: 10_000 })
        expect(host.state()).toMatchObject({ current: { runtime: RUNTIME_NEW, browser: BROWSER_NEW }, previous: { runtime: RUNTIME_OLD, browser: BROWSER_OLD } })
        expect(host.state().history.at(-1)).toMatchObject({ action: 'upgrade', result: 'ready' })
        const stop = host.calls.indexOf('systemctl stop abp-stack.service')
        expect(host.calls.indexOf('systemctl start abp-stack.service')).toBeGreaterThan(stop)
        // systemctl stop returned: the containers must really be down before the switch.
        expect(host.calls.indexOf('docker inspect -f {{.State.Running}} abp-runtime', stop)).toBeGreaterThan(stop)
        expect(host.calls.some((line) => /volume rm/.test(line))).toBe(false)
    })

    it('rolls back to the previous digests when the new Runtime never becomes ready', async () => {
        const host = fakeHost()
        const fencedAware = host.deps.ready
        host.deps.ready = async () => {
            const reply = await fencedAware()
            return reply.status === 0 ? reply : { status: host.state().current.runtime === RUNTIME_OLD ? 200 : 503, body: {} }
        }
        let clock = 0
        host.deps.now = () => (clock += 1_000)
        await expect(createStack(host.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_NEW }, readyTimeoutMs: 5_000 })).rejects.toThrow(/rolled back/)
        expect(host.state()).toMatchObject({ current: { runtime: RUNTIME_OLD, browser: BROWSER_OLD } })
        expect(host.state().history.map((entry: { action: string; result: string }) => `${entry.action}:${entry.result}`)).toEqual(['upgrade:not-ready', 'auto-rollback:ready'])
        expect(host.calls.filter((line) => line === 'systemctl start abp-stack.service')).toHaveLength(2)
    })

    it('rolls back when starting the new stack fails outright', async () => {
        let starts = 0
        const host = fakeHost({ handlers: [[/^systemctl start abp-stack.service$/, () => ({ status: ++starts === 1 ? 1 : 0 })]] })
        await expect(createStack(host.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_NEW }, readyTimeoutMs: 5_000 })).rejects.toThrow(/rolled back/)
        expect(host.state().current).toEqual({ runtime: RUNTIME_OLD, browser: BROWSER_OLD })
        expect(host.state().history.map((entry: { action: string; result: string }) => `${entry.action}:${entry.result}`)).toEqual(['upgrade:failed', 'auto-rollback:ready'])
    })

    it('records the verified fence and the explicit drain result, waiting for running batches first', async () => {
        const host = fakeHost({ running: [1, 1, 0] })
        await createStack(host.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_NEW }, readyTimeoutMs: 10_000 })
        const upgrade = host.state().history.at(-1)
        expect(upgrade).toMatchObject({ action: 'upgrade', result: 'ready', quiesce: { fence: 'verified', drain: { result: 'drained', running: 0 } } })
        expect(indexOf(host.calls, FENCE)).toBeLessThan(indexOf(host.calls, 'systemctl stop abp-stack.service'))
        expect(host.calls).toContain('iptables -w -t filter -C OUTPUT -j ABP-FENCE')
    })

    const aborts: Array<[string, HostOptions, RegExp]> = [
        ['the fence rule cannot be installed', { handlers: [[/^iptables -w -t filter -A ABP-FENCE/, () => ({ status: 1 })]] }, /fence rule not installed/],
        ['OUTPUT does not jump to the fence chain', { handlers: [[/^iptables -w -t filter -C OUTPUT -j ABP-FENCE$/, () => ({ status: 1 })]] }, /OUTPUT does not jump to ABP-FENCE/],
        ['the admin metrics are unavailable', { running: [undefined] }, /drain unavailable/],
        ['running batches do not finish in time', { running: Array(500).fill(2) }, /drain timeout \(2 running\)/],
    ]
    for (const [name, options, message] of aborts) {
        it(`aborts before stopping anything when ${name}, and lifts the fence`, async () => {
            const host = fakeHost(options)
            let clock = 0
            host.deps.now = () => (clock += 1_000)
            await expect(createStack(host.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_NEW }, readyTimeoutMs: 1_000 })).rejects.toThrow(message)
            expect(host.calls).not.toContain('systemctl stop abp-stack.service')
            expect(host.calls.at(-1)).toBe(UNFENCE)
            expect(host.state().current).toEqual({ runtime: RUNTIME_OLD, browser: BROWSER_OLD })
            expect(host.state().history.at(-1)).toMatchObject({ action: 'upgrade', result: 'aborted' })
        })
    }

    it('aborts when the Runtime API still answers behind the fence', async () => {
        const host = fakeHost()
        host.deps.ready = async () => ({ status: 200, body: {} })
        await expect(createStack(host.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_NEW }, readyTimeoutMs: 1_000 })).rejects.toThrow(/still answers behind the fence/)
        expect(host.calls).not.toContain('systemctl stop abp-stack.service')
    })

    it('aborts when Docker cannot tell whether the Runtime runs (inspection error, not a confirmed absence)', async () => {
        for (const failure of [
            { status: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' },
            { status: 0, stdout: '' },
        ]) {
            const host = fakeHost({ handlers: [[/^docker inspect -f \{\{\.State\.Running\}\} abp-runtime$/, () => failure]] })
            await expect(createStack(host.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_NEW }, readyTimeoutMs: 1_000 })).rejects.toThrow(/cannot determine whether abp-runtime is running/)
            expect(host.calls).not.toContain('systemctl stop abp-stack.service')
            expect(host.calls.some((line) => /^docker (stop|rm|create)/.test(line))).toBe(false)
            expect(host.state().current).toEqual({ runtime: RUNTIME_OLD, browser: BROWSER_OLD })
            expect(host.state().history.at(-1)).toMatchObject({ action: 'upgrade', result: 'aborted' })
        }
    })

    it('treats a confirmed missing Runtime container as not running', async () => {
        const host = fakeHost({ handlers: [[/^docker inspect -f \{\{\.State\.Running\}\} abp-runtime$/, () => ({ status: 1, stderr: 'Error: No such object: abp-runtime' })]] })
        const quiesced = await createStack(host.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_NEW }, readyTimeoutMs: 10_000 }).then(() => host.state().history.at(-1).quiesce)
        expect(quiesced).toEqual({ fence: 'not-needed', drain: { result: 'runtime-not-running' } })
    })

    it('does not count a container as stopped when its state cannot be read after the stop', async () => {
        let stopped = false
        const host = fakeHost({ handlers: [
            [/^systemctl stop abp-stack\.service$/, () => { stopped = true; return {} }],
            [/^docker inspect -f \{\{\.State\.Running\}\} abp-browser-ops$/, () => (stopped ? { status: 1, stderr: 'permission denied' } : { stdout: 'true' })],
        ] })
        await expect(createStack(host.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_NEW }, readyTimeoutMs: 5_000 })).rejects.toThrow(/rolled back|not ready either/)
        expect(host.state().history.find((entry: { action: string }) => entry.action === 'upgrade')).toMatchObject({ result: 'failed', error: expect.stringMatching(/cannot determine whether abp-browser-ops is running/) })
    })

    it('treats a stack whose Runtime is not running as quiesced, and says so', async () => {
        const host = fakeHost({ runtimeRunning: false })
        await createStack(host.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_NEW }, readyTimeoutMs: 10_000 })
        expect(host.state().history.at(-1)).toMatchObject({ action: 'upgrade', result: 'ready', quiesce: { fence: 'not-needed', drain: { result: 'runtime-not-running' } } })
    })

    it('refuses an upgrade to digests that are not loaded', async () => {
        const host = fakeHost({ handlers: [[/^docker image inspect/, () => ({ status: 1 })]] })
        await expect(createStack(host.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_NEW }, readyTimeoutMs: 1 })).rejects.toThrow(/not loaded/)
        expect(host.calls).not.toContain('systemctl stop abp-stack.service')
    })

    it('rollback switches current and previous', async () => {
        const host = fakeHost({ current: { runtime: RUNTIME_NEW, browser: BROWSER_NEW }, previous: { runtime: RUNTIME_OLD, browser: BROWSER_OLD } })
        await createStack(host.deps).rollback({ readyTimeoutMs: 10_000 })
        expect(host.state()).toMatchObject({ current: { runtime: RUNTIME_OLD }, previous: { runtime: RUNTIME_NEW } })
    })

    it('refuses a second mutating operation while one holds the lock', async () => {
        const host = fakeHost()
        const release = await host.deps.opLock()
        await expect(createStack(host.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_NEW }, readyTimeoutMs: 1 })).rejects.toThrow(/another abp-stack operation/)
        await expect(createStack(host.deps).rotateKeys()).rejects.toThrow(/another abp-stack operation/)
        await expect(createStack(host.deps).setPrincipal('main', 'x')).rejects.toThrow(/another abp-stack operation/)
        expect(host.calls).toEqual([])
        release()
        await createStack(host.deps).rotateKeys({ daemonToken: false, vncPassword: true })
    })
})

describe('abp-stack upgrade on a running stack: only containers whose digest changes are replaced', () => {
    const MAINTENANCE = '/run/abp-stack-maintenance'
    const touched = (calls: string[], name: string) => calls.filter((line) => new RegExp(`^docker (stop|kill|rm|create --name=)[^ ]*.* ?${name}( |$)`).test(line) || line.startsWith(`docker create --name=${name} `))

    it('Runtime-only: fence and drain, replace the Runtime, keep every browser (profile, pages, pending approvals), lift the fence', async () => {
        const host = fakeHost({ serviceActive: true, running: [1, 0] })
        let flagDuringReplace = false
        const create = host.deps.run
        host.deps.run = (cmd: string, args: string[], opts?: { allowFail?: boolean }) => {
            if (cmd === 'docker' && args[0] === 'create') flagDuringReplace = host.files.has(MAINTENANCE)
            return create(cmd, args, opts)
        }
        await createStack(host.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_OLD }, readyTimeoutMs: 10_000 })
        const { calls } = host
        expect(calls).not.toContain('systemctl stop abp-stack.service')
        expect(touched(calls, 'abp-browser-main')).toEqual([])
        expect(touched(calls, 'abp-browser-ops')).toEqual([])
        const fence = calls.indexOf(FENCE)
        const stop = calls.indexOf('docker stop -t 30 abp-runtime')
        const create_ = indexOf(calls, /^docker create --name=abp-runtime .*sha256:c{64}$/)
        const start = calls.indexOf('docker start abp-runtime')
        expect(fence).toBeGreaterThanOrEqual(0)
        expect(stop).toBeGreaterThan(fence)
        expect(calls.indexOf('docker rm -f abp-runtime')).toBeGreaterThan(stop)
        expect(create_).toBeGreaterThan(stop)
        expect(calls).toContain('docker network connect --alias=runtime --ip=10.249.241.3 abp-net-ops abp-runtime')
        expect(start).toBeGreaterThan(create_)
        expect(calls.indexOf(UNFENCE, start)).toBeGreaterThan(start)
        expect(flagDuringReplace).toBe(true)
        expect(host.files.has(MAINTENANCE)).toBe(false)
        expect(host.containers.get('abp-browser-main')).toEqual({ running: true, image: BROWSER_OLD })
        expect(host.state()).toMatchObject({ current: { runtime: RUNTIME_NEW, browser: BROWSER_OLD }, previous: { runtime: RUNTIME_OLD, browser: BROWSER_OLD } })
        expect(host.state().history.at(-1)).toMatchObject({ action: 'upgrade', result: 'ready', replaced: ['runtime'], quiesce: { fence: 'verified' } })
    })

    it('browser-changed: replaces the browsers at their fixed addresses and keeps the Runtime running', async () => {
        const host = fakeHost({ serviceActive: true })
        await createStack(host.deps).upgrade({ ids: { runtime: RUNTIME_OLD, browser: BROWSER_NEW }, readyTimeoutMs: 10_000 })
        const { calls } = host
        expect(touched(calls, 'abp-runtime')).toEqual([])
        expect(calls).not.toContain('docker restart -t 30 abp-runtime')
        for (const [name, ip] of [['abp-browser-main', '10.249.240.2'], ['abp-browser-ops', '10.249.241.2']]) {
            const stop = calls.indexOf(`docker stop -t 10 ${name}`)
            expect(stop).toBeGreaterThan(calls.indexOf(FENCE))
            expect(calls.indexOf(`docker rm -f ${name}`)).toBeGreaterThan(stop)
            expect(indexOf(calls, new RegExp(`^docker create --name=${name} .*--ip=${ip.replace(/\./g, '\\.')} .*sha256:d{64}$`))).toBeGreaterThan(stop)
        }
        // New browsers only behind a live egress firewall.
        expect(indexOf(calls, /check-egress$/)).toBeLessThan(indexOf(calls, /^docker create --name=abp-browser-main/))
        expect(host.containers.get('abp-runtime')).toEqual({ running: true, image: RUNTIME_OLD })
        expect(host.state().history.at(-1)).toMatchObject({ action: 'upgrade', result: 'ready', replaced: ['browser'] })
    })

    it('both changed: browsers first, then the Runtime', async () => {
        const host = fakeHost({ serviceActive: true })
        await createStack(host.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_NEW }, readyTimeoutMs: 10_000 })
        expect(indexOf(host.calls, /^docker create --name=abp-runtime /)).toBeGreaterThan(indexOf(host.calls, /^docker create --name=abp-browser-ops /))
        expect(host.state().history.at(-1)).toMatchObject({ replaced: ['browser', 'runtime'] })
    })

    it('Runtime-only that never becomes ready: puts the previous Runtime back, browsers still untouched', async () => {
        const host = fakeHost({ serviceActive: true })
        const fencedAware = host.deps.ready
        host.deps.ready = async () => {
            const reply = await fencedAware()
            return reply.status === 0 ? reply : { status: host.containers.get('abp-runtime')?.image === RUNTIME_NEW ? 503 : 200, body: {} }
        }
        let clock = 0
        host.deps.now = () => (clock += 1_000)
        await expect(createStack(host.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_OLD }, readyTimeoutMs: 5_000 })).rejects.toThrow(/rolled back/)
        expect(host.containers.get('abp-runtime')).toEqual({ running: true, image: RUNTIME_OLD })
        expect(touched(host.calls, 'abp-browser-main')).toEqual([])
        expect(host.state().current).toEqual({ runtime: RUNTIME_OLD, browser: BROWSER_OLD })
        expect(host.state().history.map((entry: { action: string; result: string }) => `${entry.action}:${entry.result}`)).toEqual(['upgrade:not-ready', 'auto-rollback:ready'])
        expect(host.files.has(MAINTENANCE)).toBe(false)
    })

    it('Runtime-only whose new container cannot be created: the previous Runtime comes back', async () => {
        const host = fakeHost({ serviceActive: true, handlers: [[/^docker create --name=abp-runtime .*sha256:c{64}$/, () => ({ status: 1 })]] })
        await expect(createStack(host.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_OLD }, readyTimeoutMs: 5_000 })).rejects.toThrow(/rolled back/)
        expect(host.containers.get('abp-runtime')).toEqual({ running: true, image: RUNTIME_OLD })
        expect(host.state().history.map((entry: { action: string; result: string }) => `${entry.action}:${entry.result}`)).toEqual(['upgrade:failed', 'auto-rollback:ready'])
    })

    it('the supervisor leaves containers alone while a fresh maintenance flag is set, and ignores a stale one', () => {
        let now = 10 * 60_000
        const host = fakeHost({ handlers: [[/^docker inspect -f \{\{\.State\.Running\}\} \{\{\.State\.ExitCode\}\}/, () => ({ stdout: 'false 0' })]] })
        host.deps.now = () => now
        host.files.set(MAINTENANCE, { data: String(now - 1_000), mode: 0o600, owner: 'root', group: 'root' })
        createStack(host.deps).superviseOnce(new Map())
        expect(host.calls.some((line) => line.startsWith('docker start'))).toBe(false)
        now += 30 * 60_000
        createStack(host.deps).superviseOnce(new Map())
        expect(host.calls.some((line) => line.startsWith('docker start'))).toBe(true)
    })
})

describe('abp-stack load', () => {
    it('loads the image archive and accepts it only when every manifest digest is present', () => {
        const manifest = JSON.stringify({ schemaVersion: 1, runtime: { id: RUNTIME_NEW }, browser: { id: BROWSER_NEW } })
        const host = fakeHost({ handlers: [[/^docker image inspect/, (args) => ({ stdout: args.at(-1) === BROWSER_NEW ? 'sha256:' + '0'.repeat(64) : args.at(-1) })]] })
        host.files.set('/imgs/manifest.json', { data: manifest, mode: 0o644, owner: 'root', group: 'root' })
        expect(() => createStack(host.deps).load('/imgs')).toThrow(/browser image digest mismatch/)
        expect(host.calls[0]).toBe('docker load -i /imgs/images.tar')
    })
})

describe('abp-stack rotate-keys', () => {
    it('rotates the daemon token: new 0400 agent file, matching hash, fenced Runtime restart, broker accepts it, daemon restarted', async () => {
        const host = fakeHost()
        await createStack(host.deps).rotateKeys({ daemonToken: true, vncPassword: false })
        const token = host.files.get(PATHS.daemonToken)!
        expect(token).toMatchObject({ mode: 0o400, owner: 'agent', group: 'agent' })
        const config = JSON.parse(host.files.get(PATHS.runtimeConfig)!.data)
        expect(config.daemonTokenSha256).toBe(createHash('sha256').update(token.data).digest('hex'))
        expect(config.brokerSocketGid).toBe(990)
        const fence = host.calls.indexOf(FENCE)
        const restart = host.calls.indexOf('docker restart -t 30 abp-runtime')
        expect(fence).toBeGreaterThanOrEqual(0)
        expect(restart).toBeGreaterThan(fence)
        expect(host.calls.indexOf('systemctl restart abp-happy-daemon.service')).toBeGreaterThan(restart)
        expect(host.calls).toContain('systemctl is-active abp-happy-daemon.service')
        // The fence also blocks the readiness probe: it is lifted before waiting for the restarted Runtime.
        const unfence = host.calls.indexOf(UNFENCE, restart)
        expect(unfence).toBeGreaterThan(restart)
        expect(host.calls.indexOf('docker inspect -f {{index .Config.Labels "ai.saycode.abp.image"}} abp-runtime', restart)).toBeGreaterThan(unfence)
        expect(host.state().history.at(-1)).toMatchObject({ action: 'rotate-keys', result: 'daemon-token' })
        expect([...host.calls, ...host.logs].join('\n')).not.toContain(token.data)
    })

    it('rotates the VNC password for the Runtime and every browser without restarting Chromium, and checks x11vnc is back', async () => {
        const host = fakeHost()
        await createStack(host.deps).rotateKeys({ daemonToken: false, vncPassword: true })
        const runtimeCopy = host.files.get(`${PATHS.runtimeSecrets}/vnc-password`)!
        const browserCopy = host.files.get(`${PATHS.browserSecrets}/vnc-password`)!
        expect(runtimeCopy.data).toBe(browserCopy.data)
        expect(runtimeCopy).toMatchObject({ mode: 0o440, owner: 'abp-runtime', group: 'root' })
        expect(browserCopy).toMatchObject({ mode: 0o400, owner: 'abp-browser', group: 'abp-browser' })
        expect(host.calls).toContain('docker exec abp-browser-main pkill -x x11vnc')
        expect(host.calls).toContain('docker exec abp-browser-ops pgrep -x x11vnc')
        expect(host.calls).toContain('docker restart -t 30 abp-runtime')
        expect(host.calls.some((line) => /restart.*abp-browser|stop.*abp-browser/.test(line))).toBe(false)
        expect([...host.calls, ...host.logs].join('\n')).not.toContain(runtimeCopy.data)
    })

    it('reports an interrupted rotation (Runtime restart fails) instead of success, and a rerun completes', async () => {
        let fail = true
        const host = fakeHost({ handlers: [[/^docker restart -t 30 abp-runtime$/, () => ({ status: fail ? 1 : 0 })]] })
        await expect(createStack(host.deps).rotateKeys({ daemonToken: true, vncPassword: false })).rejects.toThrow(/docker restart failed/)
        expect(host.logs.join('\n')).not.toMatch(/^rotated/m)
        expect(host.state().history.at(-1)).toMatchObject({ action: 'rotate-keys', result: 'failed' })
        expect(host.calls).not.toContain('systemctl restart abp-happy-daemon.service')
        fail = false
        await createStack(host.deps).rotateKeys({ daemonToken: true, vncPassword: false })
        expect(host.state().history.at(-1)).toMatchObject({ action: 'rotate-keys', result: 'daemon-token' })
    })

    it('aborts a rotation before writing anything when the drain cannot be measured', async () => {
        const host = fakeHost({ running: [undefined] })
        const before = host.files.get(PATHS.runtimeConfig)!.data
        await expect(createStack(host.deps).rotateKeys({ daemonToken: true, vncPassword: false })).rejects.toThrow(/drain unavailable/)
        expect(host.files.get(PATHS.runtimeConfig)!.data).toBe(before)
        expect(host.files.has(PATHS.daemonToken)).toBe(false)
        expect(host.calls).not.toContain('docker restart -t 30 abp-runtime')
    })

    it('fails when the restarted Runtime does not accept the new daemon token', async () => {
        const host = fakeHost()
        host.deps.brokerProbe = async () => 401
        await expect(createStack(host.deps).rotateKeys({ daemonToken: true, vncPassword: false })).rejects.toThrow(/does not accept the new daemon token/)
    })
})

describe('abp-stack set-principal', () => {
    it('reassigns a profile owner in both config files and restarts the Runtime behind the fence', async () => {
        const host = fakeHost({ profiles: [{ profileId: 'main', principalId: 'user-1' }] })
        await createStack(host.deps).setPrincipal('main', 'user-9')
        expect(JSON.parse(host.files.get(PATHS.installConfig)!.data).profiles).toEqual([{ profileId: 'main', principalId: 'user-9' }])
        const config = JSON.parse(host.files.get(PATHS.runtimeConfig)!.data)
        expect(config.profiles).toEqual([{ profileId: 'main', principalId: 'user-9' }])
        expect(config.daemonTokenSha256).toBe('e'.repeat(64))
        expect(host.calls.indexOf('docker restart -t 30 abp-runtime')).toBeGreaterThan(host.calls.indexOf(FENCE))
        expect(() => createStack(host.deps).setPrincipal('nope', 'user-9')).toThrow(/unknown profile/)
    })
})

describe('abp-stack status', () => {
    const healthy: Array<[RegExp, Handler]> = [
        [/^systemctl is-active abp-stack.service/, () => ({ stdout: 'active' })],
        [/^docker inspect -f \{\{\.State\.Running\}\} \{\{index \.Config\.Labels "ai\.saycode\.abp\.image"\}\} abp-runtime/, () => ({ stdout: `true ${RUNTIME_OLD}` })],
        [/^docker inspect -f \{\{\.State\.Running\}\} \{\{index \.Config\.Labels "ai\.saycode\.abp\.image"\}\} abp-browser/, () => ({ stdout: `true ${BROWSER_OLD}` })],
        [/^docker ps --filter label=ai.saycode.abp=stack --format/, () => ({ stdout: 'abp-runtime\t127.0.0.1:38700->38700/tcp\nabp-browser-main\t5900/tcp, 9223-9224/tcp\nabp-browser-ops\t' })],
        [/^docker exec abp-browser-\S+ sh -c/, () => ({ stdout: 'sandboxed 2\nnosandbox 0' })],
    ]

    it('reports ready when only the Runtime port is published on loopback, egress rules are live and Chromium runs sandboxed', async () => {
        const host = fakeHost({ handlers: healthy })
        const report = await createStack(host.deps).status()
        expect(report.checks.map((check: { name: string }) => check.name)).toContain('browser egress firewall')
        expect(report.ok).toBe(true)
    })

    it('fails on any other published port, a browser without its sandbox, missing egress rules or an unpinned image', async () => {
        const host = fakeHost({ handlers: [
            [/^docker ps --filter/, () => ({ stdout: 'abp-runtime\t0.0.0.0:38700->38700/tcp\nabp-browser-main\t127.0.0.1:6080->6080/tcp' })],
            [/^docker exec abp-browser-main sh -c/, () => ({ stdout: 'sandboxed 0\nnosandbox 1' })],
            [/^docker inspect -f \{\{\.State\.Running\}\} \{\{index \.Config\.Labels "ai\.saycode\.abp\.image"\}\} abp-browser-ops/, () => ({ stdout: `true ${BROWSER_NEW}` })],
            [/check-egress$/, () => ({ status: 1 })],
            ...healthy,
        ] })
        const report = await createStack(host.deps).status()
        expect(report.ok).toBe(false)
        const failed = report.checks.filter((check: { ok: boolean }) => !check.ok).map((check: { name: string }) => check.name)
        expect(failed).toEqual(expect.arrayContaining(['published ports', 'chromium sandbox abp-browser-main', 'container abp-browser-ops', 'browser egress firewall']))
    })
})
