import { createHash, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createStack } from './abp-stack.mjs'
import { mergeInstallOptions, PATHS, profileVolumeLabels, profileVolumeName, sharedProfileId } from './lib/abpPlan.mjs'

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
    /** A shared machine: [user, network slot] per profile (contract 3 images and package). */
    shared?: Array<[string, number]>
    memory?: { totalBytes: number; availableBytes: number }
    /** Whether the Runtime reports every browser connected for these profiles (default: yes). */
    browsersReady?: (profiles: Array<{ profileId: string }>) => boolean
    /** Profiles whose browser the Runtime reports not connected (per-profile readiness). */
    brokenBrowsers?: string[]
    /** Profile requests the Runtime's admin socket lists (first use on a shared machine). */
    requests?: Array<{ principalId: string; requestedAtMs: number }>
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
    const issuers = [{ kid: 'k1', publicKeyPem: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString() }]
    const install = options.shared ? {
        ...mergeInstallOptions(undefined, { tenancyMode: 'shared', machineId: 'machine-1', workspaceId: 'ws-1', issuers }),
        profiles: options.shared.map(([principalId, networkSlot], i) => ({ profileId: sharedProfileId(principalId), principalId, assignmentId: String(i + 1).repeat(32), networkSlot })),
    } : {
        ...mergeInstallOptions(undefined, {
            machineId: 'machine-1', workspaceId: 'ws-1',
            profiles: [{ profileId: 'main', principalId: 'user-1' }],
            issuers,
        }),
        // Two profiles exercise the per-profile loops; release 1 installs only main (see the set-principal test).
        profiles: (options.profiles ?? [{ profileId: 'main', principalId: 'user-1' }, { profileId: 'ops', principalId: 'user-2' }]).map((p, i) => ({ ...p, assignmentId: String(i + 1).repeat(32) })),
    }
    const contract = options.shared ? '3' : '2'
    files.set(`${install.happyPrefix}/lib/node_modules/@buzzni/happy-cli/scripts/agent-browser/contract.json`, { data: `{"contractVersion":${contract}}`, mode: 0o644, owner: 'root', group: 'root' })
    files.set(PATHS.installConfig, { data: JSON.stringify(install), mode: 0o600, owner: 'root', group: 'root' })
    files.set(PATHS.runtimeConfig, { data: JSON.stringify({ daemonTokenSha256: 'e'.repeat(64) }), mode: 0o600, owner: 'root', group: 'root' })
    files.set(PATHS.stackState, { data: JSON.stringify({ schemaVersion: 1, current: options.current === undefined ? { runtime: RUNTIME_OLD, browser: BROWSER_OLD } : options.current, previous: options.previous ?? null, history: [] }), mode: 0o600, owner: 'root', group: 'root' })
    const volumes = new Map<string, Record<string, string>>()
    const ensureVolumes = () => {
        for (const p of JSON.parse(files.get(PATHS.installConfig)!.data).profiles) {
            const name = profileVolumeName(p.profileId, p.principalId)
            if (!volumes.has(name)) volumes.set(name, Object.fromEntries(profileVolumeLabels(p.profileId, p.principalId).map((l: string) => l.split('='))))
        }
    }
    ensureVolumes()
    const state = () => JSON.parse(files.get(PATHS.stackState)!.data)
    const running = [...(options.running ?? [])]
    const containers = new Map<string, { running: boolean; image: string; mounts: string[] }>()
    // As start() does: every browser mounts its current owner's volume (read from install.json).
    const recreateAll = (up: boolean) => {
        const current = state().current ?? { runtime: '', browser: '' }
        const owners = new Map<string, string>(JSON.parse(files.get(PATHS.installConfig)!.data).profiles.map((p: { profileId: string; principalId: string }) => [p.profileId, p.principalId]))
        for (const name of ['abp-runtime', ...[...owners.keys()].map((profileId) => `abp-browser-${profileId}`)]) {
            const profileId = name.replace('abp-browser-', '')
            containers.set(name, { running: up, image: name === 'abp-runtime' ? current.runtime : current.browser,
                mounts: name === 'abp-runtime' ? ['abp-state'] : [profileVolumeName(profileId, owners.get(profileId)!)] })
        }
    }
    recreateAll(true)
    containers.get('abp-runtime')!.running = options.runtimeRunning ?? true
    let lockHeld = false
    // The fence resets host packets to the API port: while it is up, the Runtime does not answer.
    let serviceActive = options.serviceActive ?? false
    let fenced = false
    let secretCount = 0
    let clock = 1_000_000
    const refusals: Array<{ principalId: string; reason: string; retryAfterMs: number }> = []
    const deps = {
        run(cmd: string, args: string[], opts: { allowFail?: boolean } = {}): Result {
            const line = [cmd, ...args].join(' ')
            calls.push(line)
            const handlers: Array<[RegExp, Handler]> = [
                ...options.handlers ?? [],
                [/^iptables -w -t filter -C ABP-FENCE /, () => ({ status: fenced ? 0 : 1 })],
                [/^systemctl is-active abp-stack\.service$/, () => (serviceActive ? { stdout: 'active' } : { status: 3, stdout: 'inactive' })],
                [/^docker image inspect/, (a) => ({ stdout: a.includes('{{index .Config.Labels "ai.saycode.abp.contract"}}') ? contract : a.at(-1) })],
                [/^docker volume inspect /, (a) => volumes.has(a.at(-1)!) ? { stdout: JSON.stringify([{ Name: a.at(-1), Labels: volumes.get(a.at(-1)!) }]) } : { status: 1, stderr: 'no such volume' }],
                [/^docker volume ls -q$/, () => ({ stdout: [...volumes.keys()].join('\n') })],
                [/^docker inspect -f \{\{json \.Mounts\}\}/, (a) => ({ stdout: JSON.stringify((containers.get(a.at(-1)!)?.mounts ?? []).map((Name) => ({ Name, Destination: '/home/browser/profile', Type: 'volume', RW: true }))) })],
                [/^docker inspect -f \{\{\.State\.Running\}\} (\S+)$/, (a) => ({ stdout: String(containers.get(a.at(-1)!)?.running ?? false) })],
                [/^docker inspect -f \{\{\.State\.Running\}\} \{\{index \.Config\.Labels "ai\.saycode\.abp\.image"\}\} (\S+)$/, (a) => {
                    const container = containers.get(a.at(-1)!)
                    return container ? { stdout: `${container.running} ${container.image}` } : { status: 1 }
                }],
                [new RegExp(`^${LABEL.replace(/[{}.]/g, '\\$&')}$`), () => ({ stdout: containers.get('abp-runtime')?.image ?? '' })],
                [/^docker inspect -f \{\{range \.Mounts\}\}\{\{\.Name\}\} \{\{end\}\} (\S+)$/, (a) => {
                    const container = containers.get(a.at(-1)!)
                    return container ? { stdout: container.mounts.join(' ') } : { status: 1, stderr: 'No such object' }
                }],
            ]
            let result: Result = { status: 0, stdout: '', stderr: '' }
            for (const [pattern, handler] of handlers) {
                if (pattern.test(line)) { result = { status: 0, stdout: '', stderr: '', ...handler(args) }; break }
            }
            if (result.status === 0) {
                if (line === FENCE) fenced = true
                if (line === UNFENCE) fenced = false
                // abp-stack.service: its stop takes the stack down; its start recreates it and lifts the fence.
                if (line === 'systemctl stop abp-stack.service') { serviceActive = false; for (const container of containers.values()) container.running = false }
                if (line === 'systemctl start abp-stack.service') { serviceActive = true; ensureVolumes(); recreateAll(true); fenced = Boolean(state().transition) }
                const name = args.at(-1)!
                if (cmd === 'docker' && args[0] === 'volume' && args[1] === 'create') volumes.set(name, Object.fromEntries(args.filter((a) => a.startsWith('--label=')).map((a) => a.slice(8).split('='))))
                if (cmd === 'docker' && args[0] === 'volume' && args[1] === 'rm') volumes.delete(name)
                if (cmd === 'docker' && args[0] === 'create') containers.set(args[1].replace('--name=', ''), { running: false, image: name,
                    mounts: args.filter((arg) => arg.startsWith('--mount=type=volume,')).map((arg) => /source=([^,]+)/.exec(arg)![1]) })
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
        async ready() { return { status: fenced ? 0 : JSON.parse(files.get(PATHS.runtimeConfig)!.data).admissionHold ? 503 : 200, body: {} } },
        async adminReady() {
            const profiles = JSON.parse(files.get(PATHS.installConfig)!.data).profiles
            return { admission: JSON.parse(files.get(PATHS.runtimeConfig)!.data).admissionHold ? 'hold' : 'open', checks: { browsers: options.browsersReady?.(profiles) ?? true, writerLock: true, disk: true, revocations: true, principalState: true }, profiles,
                profileBrowsers: Object.fromEntries(profiles.map((p: any) => [p.profileId, !(options.brokenBrowsers ?? []).includes(p.profileId)])),
                assignment: { state: 'ready', applied: Object.fromEntries(profiles.map((p: any) => [p.profileId, p.assignmentId])) } }
        },
        async openAdmission(_assignments: Record<string, string>) { return true },
        async adminMetrics() {
            const value = running.length ? running.shift() : 0
            return value === undefined ? undefined : { tasks: { running: value } }
        },
        async brokerProbe(token: string) { return token === JSON.parse(files.get(PATHS.runtimeConfig)!.data).probeToken ? 401 : 200 },
        async sleep(ms = 1000) { clock += ms },
        memInfo: () => options.memory ?? { totalBytes: 16 * 2 ** 30, availableBytes: 9 * 2 ** 30 },
        async adminProfileRequests() { return options.requests ?? [] },
        async refuseProfileRequest(principalId: string, reason: string, retryAfterMs: number) { refusals.push({ principalId, reason, retryAfterMs }); return true },
        now: () => clock,
        log: (line: string) => { logs.push(line) },
        secret: (kind: string) => `synthetic-${kind}-${++secretCount}`.padEnd(kind === 'vnc-password' ? 0 : 40, 'x').slice(0, kind === 'vnc-password' ? 8 : 64),
        async opLock() {
            if (lockHeld) throw new Error('another abp-stack operation is running')
            lockHeld = true
            return () => { lockHeld = false }
        },
    }
    return { deps, calls, logs, files, state, containers, volumes, refusals }
}

const indexOf = (calls: string[], pattern: RegExp | string) => calls.findIndex((line) => (typeof pattern === 'string' ? line === pattern : pattern.test(line)))

describe('abp-stack start', () => {
    it('requires the browser egress firewall, recreates mismatched networks, starts browsers before the Runtime at fixed addresses, then lifts the fence', async () => {
        const host = fakeHost({ handlers: [
            [/^docker network inspect -f .* abp-net-main$/, () => ({ stdout: '10.249.240.0/24 10.249.240.1 br-abp-wrong' })],
            [/^docker network inspect -f .* abp-net-ops$/, () => ({ status: 1 })],

            [/^docker ps -aq --filter label=ai.saycode.abp=stack/, () => ({ stdout: 'old1\nold2' })],
        ] })
        await createStack(host.deps).start()
        const { calls } = host
        expect(calls[0]).toBe(`${FIREWALL} check-egress`)
        const removeOld = indexOf(calls, 'docker rm -f old2')
        // Containers go before their networks can be replaced.
        expect(indexOf(calls, 'docker network rm abp-net-main')).toBeGreaterThan(removeOld)
        expect(indexOf(calls, /^docker network create .*--subnet=10\.249\.240\.0\/24 .*abp-net-main$/)).toBeGreaterThan(indexOf(calls, 'docker network rm abp-net-main'))
        expect(indexOf(calls, /^docker network create .*--subnet=10\.249\.241\.0\/24 .*abp-net-ops$/)).toBeGreaterThan(removeOld)
        const opsVolume = profileVolumeName('ops', 'user-2')
        expect(host.volumes.has(opsVolume)).toBe(true)
        const browserCreate = indexOf(calls, /^docker create --name=abp-browser-main .*--ip=10\.249\.240\.2 .*sha256:b{64}$/)
        const runtimeCreate = indexOf(calls, /^docker create --name=abp-runtime .*--ip=10\.249\.240\.3 .*sha256:a{64}$/)
        expect(browserCreate).toBeGreaterThan(removeOld)
        expect(runtimeCreate).toBeGreaterThan(browserCreate)
        expect(calls).toContain('docker network connect --alias=runtime --ip=10.249.241.3 abp-net-ops abp-runtime')
        expect(calls.lastIndexOf(UNFENCE)).toBeGreaterThan(indexOf(calls, 'docker start abp-runtime'))
        expect(calls.some((line) => /volume rm|--no-sandbox/.test(line))).toBe(false)
    })

    it('preserves unknown-owner legacy data and refuses automatic attachment or deletion', async () => {
        const host = fakeHost({ handlers: [[/^docker volume ls -q$/, () => ({ stdout: 'abp-state\nabp-profile-main' })]] })
        await expect(createStack(host.deps).start()).rejects.toThrow(/legacy|migration/i)
        expect(host.calls.some((line) => line.startsWith('docker volume rm'))).toBe(false)
        expect(host.calls.some((line) => line.includes('source=abp-profile-main,'))).toBe(false)
    })

    it('rewrites runtime.json from install.json when their owners differ (an interrupted reassignment)', async () => {
        const host = fakeHost()
        host.files.set(PATHS.runtimeConfig, { data: JSON.stringify({ machineId: 'machine-1', daemonTokenSha256: 'e'.repeat(64), profiles: [{ profileId: 'main', principalId: 'user-old' }] }), mode: 0o600, owner: 'root', group: 'root' })
        await createStack(host.deps).start()
        const config = JSON.parse(host.files.get(PATHS.runtimeConfig)!.data)
        expect(config.profiles).toEqual(JSON.parse(host.files.get(PATHS.installConfig)!.data).profiles)
        expect(config.daemonTokenSha256).toBe('e'.repeat(64))
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
        expect(indexOf(calls, 'docker stop -t 30 abp-browser-main')).toBeGreaterThan(stopRuntime)
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
        expect(host.calls).toContain('docker stop -t 30 abp-browser-main')
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
        expect(host.calls.filter((line) => line === 'systemctl start abp-stack.service')).toHaveLength(1)
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
        await expect(createStack(host.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_NEW }, readyTimeoutMs: 5_000 })).rejects.toThrow(/cannot determine whether abp-browser-ops is running/)
        expect(host.calls).not.toContain('systemctl start abp-stack.service')
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

    it('refuses legacy adoption during upgrade and preserves its cookies', async () => {
        const host = fakeHost({ serviceActive: true, profiles: [{ profileId: 'main', principalId: 'user-1' }],
            handlers: [[/^docker volume ls -q$/, () => ({ stdout: 'abp-state\nabp-profile-main' })]] })
        host.containers.get('abp-browser-main')!.mounts = ['abp-profile-main']
        await expect(createStack(host.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_OLD } })).rejects.toThrow(/legacy/)
        expect(host.calls.some((line) => /volume rm|docker create/.test(line))).toBe(false)
    })

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
        expect(host.containers.get('abp-browser-main')).toMatchObject({ running: true, image: BROWSER_OLD })
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
            const stop = calls.indexOf(`docker stop -t 30 ${name}`)
            expect(stop).toBeGreaterThan(calls.indexOf(FENCE))
            expect(calls.indexOf(`docker rm -f ${name}`)).toBeGreaterThan(stop)
            expect(indexOf(calls, new RegExp(`^docker create --name=${name} .*--ip=${ip.replace(/\./g, '\\.')} .*sha256:d{64}$`))).toBeGreaterThan(stop)
        }
        // New browsers only behind a live egress firewall.
        expect(indexOf(calls, /check-egress$/)).toBeLessThan(indexOf(calls, /^docker create --name=abp-browser-main/))
        expect(host.containers.get('abp-runtime')).toMatchObject({ running: true, image: RUNTIME_OLD })
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
        expect(host.containers.get('abp-runtime')).toMatchObject({ running: true, image: RUNTIME_OLD })
        expect(touched(host.calls, 'abp-browser-main')).toEqual([])
        expect(host.state().current).toEqual({ runtime: RUNTIME_OLD, browser: BROWSER_OLD })
        expect(host.state().history.map((entry: { action: string; result: string }) => `${entry.action}:${entry.result}`)).toEqual(['upgrade:not-ready', 'auto-rollback:ready'])
        expect(host.files.has(MAINTENANCE)).toBe(false)
    })

    it('Runtime-only whose new container cannot be created: the previous Runtime comes back', async () => {
        const host = fakeHost({ serviceActive: true, handlers: [[/^docker create --name=abp-runtime .*sha256:c{64}$/, () => ({ status: 1 })]] })
        await expect(createStack(host.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_OLD }, readyTimeoutMs: 5_000 })).rejects.toThrow(/rolled back/)
        expect(host.containers.get('abp-runtime')).toMatchObject({ running: true, image: RUNTIME_OLD })
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
        const host = fakeHost({ handlers: [[/^docker image inspect --format \{\{\.Id\}\}/, (args) => ({ stdout: args.at(-1) === BROWSER_NEW ? 'sha256:' + '0'.repeat(64) : args.at(-1) })]] })
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
        // Readiness is checked on the root admin socket before the public fence is lifted.
        const unfence = host.calls.indexOf(UNFENCE, restart)
        expect(unfence).toBeGreaterThan(restart)
        expect(host.calls.indexOf('docker inspect -f {{.State.Running}} {{index .Config.Labels "ai.saycode.abp.image"}} abp-runtime', restart)).toBeLessThan(unfence)
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
    const one = [{ profileId: 'main', principalId: 'user-1' }]
    const owners = (host: ReturnType<typeof fakeHost>, path: string) => JSON.parse(host.files.get(path)!.data).profiles

    it('does nothing when the profile already belongs to that owner', async () => {
        const host = fakeHost({ profiles: one, serviceActive: true })
        await createStack(host.deps).setPrincipal('main', 'user-1')
        expect(host.calls.some((line) => /systemctl (stop|start)|ABP-FENCE -p/.test(line))).toBe(false)
        await expect(createStack(host.deps).setPrincipal('nope', 'user-9')).rejects.toThrow(/unknown profile/)
    })

    it("stops the whole stack, switches both config files, and starts it on the new owner's volume; the previous volume is kept, detached", async () => {
        const host = fakeHost({ profiles: one, serviceActive: true })
        await createStack(host.deps).setPrincipal('main', 'user-9')
        const { calls } = host
        expect(indexOf(calls, 'systemctl stop abp-stack.service')).toBeGreaterThan(indexOf(calls, FENCE))
        expect(indexOf(calls, 'systemctl start abp-stack.service')).toBeGreaterThan(indexOf(calls, 'systemctl stop abp-stack.service'))
        expect(owners(host, PATHS.installConfig)).toEqual([{ profileId: 'main', principalId: 'user-9', assignmentId: expect.stringMatching(/^[0-9a-f]{32}$/) }])
        expect(owners(host, PATHS.runtimeConfig)).toEqual([{ profileId: 'main', principalId: 'user-9', assignmentId: expect.stringMatching(/^[0-9a-f]{32}$/) }])
        expect(JSON.parse(host.files.get(PATHS.runtimeConfig)!.data).daemonTokenSha256).toBe('e'.repeat(64))
        expect(host.containers.get('abp-browser-main')!.mounts).toEqual([profileVolumeName('main', 'user-9')])
        expect(host.state().profileVolumes).toEqual([
            { profileId: 'main', volume: profileVolumeName('main', 'user-1'), detachedAtMs: 1_000_000 },
            { profileId: 'main', volume: profileVolumeName('main', 'user-9') },
        ])
        expect(host.state().history.findLast((entry: { action: string }) => entry.action === 'set-principal')).toMatchObject({ profileId: 'main', result: 'ready' })
        expect(host.state().applied.main.principalId).toBe('user-9')
    })

    it('clears the detached mark when a previous owner is assigned back', async () => {
        const host = fakeHost({ profiles: one, serviceActive: true })
        await createStack(host.deps).setPrincipal('main', 'user-9')
        await createStack(host.deps).setPrincipal('main', 'user-1')
        expect(host.containers.get('abp-browser-main')!.mounts).toEqual([profileVolumeName('main', 'user-1')])
        expect(host.state().profileVolumes).toEqual([
            { profileId: 'main', volume: profileVolumeName('main', 'user-1') },
            { profileId: 'main', volume: profileVolumeName('main', 'user-9'), detachedAtMs: 1_000_000 },
        ])
    })

    it('restores the previous owner, config and volume marks when the switched stack cannot be verified', async () => {
        let inspected = 0
        const host: ReturnType<typeof fakeHost> = fakeHost({ profiles: one, serviceActive: true, handlers: [
            // The first check after the switch sees the old volume still mounted; later ones see the real mount.
            [/^docker inspect -f \{\{json \.Mounts\}\} abp-browser-main$/, () => ({
                stdout: JSON.stringify([{ Name: ++inspected === 1 ? profileVolumeName('main', 'user-1') : host.containers.get('abp-browser-main')!.mounts[0], Destination: '/home/browser/profile', Type: 'volume', RW: true }]) })],
        ] })
        await expect(createStack(host.deps).setPrincipal('main', 'user-9')).rejects.toThrow(/set-principal failed.*restored/)
        expect(owners(host, PATHS.installConfig)).toMatchObject(one)
        expect(owners(host, PATHS.installConfig)[0].assignmentId).not.toBe('1'.repeat(32))
        expect(owners(host, PATHS.runtimeConfig)).toMatchObject(one)
        expect(host.containers.get('abp-browser-main')!.mounts).toEqual([profileVolumeName('main', 'user-1')])
        expect(host.state().profileVolumes ?? []).toEqual([])
        expect(host.calls.filter((line) => line === 'systemctl start abp-stack.service')).toHaveLength(2)
        expect(host.state().transition).toBeUndefined()
    })

    it('stops containers directly and reports an unverified supervisor after systemd stop fails', async () => {
        let stops = 0
        const host = fakeHost({ profiles: one, serviceActive: true, handlers: [
            [/^docker inspect -f \{\{json \.Mounts\}\}/, () => ({ stdout: '[]' })],
            [/^systemctl stop abp-stack.service$/, () => ({ status: ++stops > 1 ? 1 : 0 })],
        ] })
        await expect(createStack(host.deps).setPrincipal('main', 'user-9')).rejects.toThrow(/safety unverified.*supervisor/)
        expect([...host.containers.values()].every((c) => !c.running)).toBe(true)
        expect(host.calls).toContain('docker stop -t 30 abp-runtime')
        expect(host.state().transition.phase).toBe('blocked')
    })

    it('reports unverified safety when the final fence fails, while still stopping containers', async () => {
        let attempts = 0
        const host = fakeHost({ profiles: one, serviceActive: true, handlers: [
            [/^docker inspect -f \{\{json \.Mounts\}\}/, () => ({ stdout: '[]' })],
            [/^iptables -w -t filter -A ABP-FENCE/, () => ({ status: ++attempts > 1 ? 1 : 0 })],
        ] })
        await expect(createStack(host.deps).setPrincipal('main', 'user-9')).rejects.toThrow(/safety unverified.*fence/)
        expect(host.state().transition.phase).toBe('blocked')
        expect([...host.containers.values()].every((c) => !c.running)).toBe(true)
    })

    it('leaves the stack stopped and fenced when even the restore cannot be verified', async () => {
        const host = fakeHost({ profiles: one, serviceActive: true, handlers: [
            [/^docker inspect -f \{\{json \.Mounts\}\}/, () => ({ stdout: '[]' })],
        ] })
        await expect(createStack(host.deps).setPrincipal('main', 'user-9')).rejects.toThrow(/restore failed/)
        expect(host.calls.filter((line) => /^systemctl (start|stop) abp-stack\.service$/.test(line)).at(-1)).toBe('systemctl stop abp-stack.service')
        // The fence is put back last, so nothing reaches the API until an operator acts.
        expect(host.calls.filter((line) => line.includes('ABP-FENCE') && !line.includes('-C OUTPUT')).at(-1)).toBe(FENCE)
    })
})

describe('indefinite profile retention', () => {
    it('keeps the previous volume after reassignment even with the obsolete zero-day setting', async () => {
        const host = fakeHost({ profiles: [{ profileId: 'main', principalId: 'user-1' }], serviceActive: true })
        host.files.set(PATHS.installConfig, { ...host.files.get(PATHS.installConfig)!, data: JSON.stringify({ ...JSON.parse(host.files.get(PATHS.installConfig)!.data), profileRetentionDays: 0 }) })
        await createStack(host.deps).setPrincipal('main', 'user-9')
        expect(host.calls.some((line) => line.startsWith('docker volume rm'))).toBe(false)
        expect(host.state().history.some((entry: { action: string }) => entry.action === 'prune-profiles')).toBe(false)
    })
})

describe('mount inspection failures', () => {
    it('aborts a runtime-only upgrade before replacing anything when a browser mount cannot be read', async () => {
        const host = fakeHost({ serviceActive: true, handlers: [
            [/^docker inspect -f .*Mounts.* abp-browser-main$/, () => ({ status: 1, stderr: 'daemon unavailable' })],
        ] })
        await expect(createStack(host.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_OLD } })).rejects.toThrow()
        expect(host.calls.some((c) => c.startsWith('docker create'))).toBe(false)
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

    it.each([
        { status: 1, stderr: 'daemon unavailable' },
        { stdout: '[]' },
        { stdout: JSON.stringify([{ Name: 'abp-profile-main', Destination: '/home/browser/profile', Type: 'volume', RW: true }]) },
        { stdout: JSON.stringify([{ Name: profileVolumeName('main', 'user-1'), Destination: '/wrong', Type: 'volume', RW: true }]) },
    ])('reports an unhealthy actual profile mount: %j', async (result) => {
        const host = fakeHost({ handlers: [[/^docker inspect -f \{\{json \.Mounts\}\} abp-browser-main$/, () => result], ...healthy] })
        const report = await createStack(host.deps).status()
        expect(report.ok).toBe(false)
        expect(report.checks).toContainEqual(expect.objectContaining({ name: 'profile mount abp-browser-main', ok: false }))
    })

    it("lists the current owners' volumes, the kept previous ones and unmarked ones (informational)", async () => {
        const kept = profileVolumeName('main', 'user-old')
        const unmarked = profileVolumeName('main', 'user-lost')
        const host = fakeHost({ handlers: [...healthy, [/^docker volume ls -q --filter label=ai\.saycode\.abp\.role=profile$/, () => ({ stdout: [profileVolumeName('main', 'user-1'), kept, unmarked].join('\n') })]] })
        host.files.set(PATHS.stackState, { ...host.files.get(PATHS.stackState)!, data: JSON.stringify({ ...host.state(), profileVolumes: [{ profileId: 'main', volume: kept, detachedAtMs: 0 }] }) })
        const report = await createStack(host.deps).status()
        const check = report.checks.find((entry: { name: string }) => entry.name === 'profile volumes')
        expect(check).toMatchObject({ ok: true })
        expect(check.detail).toContain(`current ${profileVolumeName('main', 'user-1')}`)
        expect(check.detail).toContain('kept 1 (oldest detached 1970-01-01)')
        expect(check.detail).toContain('unmarked 1')
    })

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


describe('assignment safety boundaries', () => {
    const one = [{ profileId: 'main', principalId: 'user-1' }]
    const putState = (host: ReturnType<typeof fakeHost>, patch: object) => host.files.set(PATHS.stackState, { ...host.files.get(PATHS.stackState)!, data: JSON.stringify({ ...host.state(), ...patch }) })

    it('changes the execution generation on A to B to A while reusing A cookies', async () => {
        const host = fakeHost({ profiles: one })
        const stack = createStack(host.deps)
        await stack.setPrincipal('main', 'user-2')
        const b = host.state().applied.main.assignmentId
        await stack.setPrincipal('main', 'user-1')
        expect(host.state().applied.main.assignmentId).not.toBe(b)
        expect(host.state().applied.main.assignmentId).not.toBe('1'.repeat(32))
        expect(host.containers.get('abp-browser-main')!.mounts).toEqual([profileVolumeName('main', 'user-1')])
    })

    it.each(['prepared', 'committed', 'verified', 'blocked'])('keeps the supervisor and administrative mutations held for a %s journal', async (phase) => {
        const host = fakeHost({ profiles: one })
        const options = JSON.parse(host.files.get(PATHS.installConfig)!.data)
        putState(host, { transition: { phase, profileId: 'main', before: options, target: options } })
        const stack = createStack(host.deps)
        stack.superviseOnce(new Map())
        expect(host.calls.every((line) => line.includes('check-egress'))).toBe(true)
        await expect(stack.upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_NEW } })).rejects.toThrow(/transition/)
        await expect(stack.rotateKeys()).rejects.toThrow(/transition/)
        if (['committed', 'verified'].includes(phase)) {
            await stack.start()
            expect(host.calls.lastIndexOf(UNFENCE)).toBeLessThan(host.calls.indexOf('docker start abp-runtime'))
            expect(JSON.parse(host.files.get(PATHS.runtimeConfig)!.data).admissionHold).toBe(true)
        } else await expect(stack.start()).rejects.toThrow(/transition/)
        await stack.setPrincipal(undefined, undefined, 'abort')
        expect(host.state().transition).toBeUndefined()
        expect(host.state().applied.main.assignmentId).not.toBe('1'.repeat(32))
    })

    it.each([['resume', 'user-2', 'user-1'], ['abort', 'user-1', 'user-2']])('marks the owner it leaves detached on --%s after install.json already switched', async (recovery, attached, detached) => {
        const host = fakeHost({ profiles: one })
        const before = JSON.parse(host.files.get(PATHS.installConfig)!.data)
        const target = { ...before, profiles: [{ profileId: 'main', principalId: 'user-2', assignmentId: 'b'.repeat(32) }] }
        // Interrupted after the commit: install.json already names the new owner.
        host.files.set(PATHS.installConfig, { ...host.files.get(PATHS.installConfig)!, data: JSON.stringify(target) })
        putState(host, { transition: { id: 'j', phase: 'committed', profileId: 'main', before, target, requested: target } })
        await createStack(host.deps).setPrincipal(undefined, undefined, recovery as 'resume' | 'abort')
        const marks = host.state().profileVolumes as Array<{ volume: string; detachedAtMs?: number }>
        expect(marks.find((mark) => mark.volume === profileVolumeName('main', detached))?.detachedAtMs).toBe(1_000_000)
        expect(marks.find((mark) => mark.volume === profileVolumeName('main', attached))?.detachedAtMs).toBeUndefined()
        expect(host.containers.get('abp-browser-main')!.mounts).toEqual([profileVolumeName('main', attached)])
    })

    it('rejects direct identity edits after an applied assignment', async () => {
        const host = fakeHost({ profiles: one })
        await createStack(host.deps).start()
        const config = JSON.parse(host.files.get(PATHS.installConfig)!.data)
        config.profiles[0].principalId = 'intruder'
        host.files.set(PATHS.installConfig, { ...host.files.get(PATHS.installConfig)!, data: JSON.stringify(config) })
        await expect(createStack(host.deps).start()).rejects.toThrow(/direct edits/)
    })

    it('fails closed on volume inspection errors and wrong labels', async () => {
        const unknown = fakeHost({ profiles: one, handlers: [[/^docker volume inspect abp-profile-/, () => ({ status: 1, stderr: 'daemon unavailable' })]] })
        await expect(createStack(unknown.deps).start()).rejects.toThrow(/cannot inspect/)
        expect(unknown.calls.some((line) => line.startsWith('docker volume create') && line.includes('abp-profile'))).toBe(false)
        const wrong = fakeHost({ profiles: one })
        wrong.volumes.set(profileVolumeName('main', 'user-1'), { 'ai.saycode.abp': 'stack' })
        await expect(createStack(wrong.deps).start()).rejects.toThrow(/labels mismatch/)
    })

    it('rejects old-contract image rollback before quiescing', async () => {
        const host = fakeHost({ previous: { runtime: RUNTIME_NEW, browser: BROWSER_NEW }, handlers: [[/ai.saycode.abp.contract/, () => ({ stdout: '1' })]] })
        await expect(createStack(host.deps).rollback()).rejects.toThrow(/contract 2/)
        expect(host.calls).not.toContain(FENCE)
    })

    it('deletes only the explicitly confirmed inactive, detached, correctly labelled volume', async () => {
        const host = fakeHost({ profiles: one })
        const volume = profileVolumeName('main', 'old-owner')
        host.volumes.set(volume, Object.fromEntries(profileVolumeLabels('main', 'old-owner').map((l: string) => l.split('='))))
        const stack = createStack(host.deps)
        await expect(stack.deleteProfileVolume(volume, 'wrong')).rejects.toThrow(/exact/)
        await expect(stack.deleteProfileVolume(profileVolumeName('main', 'user-1'), profileVolumeName('main', 'user-1'))).rejects.toThrow(/current/)
        await stack.deleteProfileVolume(volume, volume)
        expect(host.volumes.has(volume)).toBe(false)
    })

    it('requires ownership confirmation, preserves legacy source, and blocks incomplete copy targets', async () => {
        const host = fakeHost({ profiles: one, handlers: [[/^docker run /, () => ({ status: 1, stderr: 'copy failed' })]] })
        const source = 'abp-profile-main'
        host.volumes.set(source, { 'ai.saycode.abp': 'stack' })
        const stack = createStack(host.deps)
        await expect(stack.migrateLegacyProfile('main', 'actual-owner', false)).rejects.toThrow(/owner-verified/)
        await expect(stack.migrateLegacyProfile('main', 'actual-owner', true)).rejects.toThrow(/docker run failed/)
        expect(host.volumes.has(source)).toBe(true)
        expect(host.state().migrations[0].phase).toBe('copying')
        await expect(stack.start()).rejects.toThrow(/migration/)
        expect(host.calls.some((line) => line.startsWith('docker volume rm'))).toBe(false)
        const originalRun = host.deps.run
        host.deps.run = (cmd, args, opts) => cmd === 'docker' && args[0] === 'run'
            ? { status: 0, stdout: JSON.stringify({ verified: true, sha256: 'a'.repeat(64) }), stderr: '' }
            : originalRun(cmd, args, opts)
        await expect(stack.migrateLegacyProfile('main', 'different-owner', true, true)).rejects.toThrow(/matching/)
        await stack.migrateLegacyProfile('main', 'actual-owner', true, true)
        expect(host.state().migrations[0].phase).toBe('verified')
        expect(host.state().migrationHold).toBe(false)
        expect(host.volumes.has(source)).toBe(true)
    })
})


describe('assignment transaction write failures', () => {
    it.each(['install', 'runtime', 'committed', 'applied'])('recovers a %s write failure with a new old-owner generation', async (point) => {
        const host = fakeHost({ profiles: [{ profileId: 'main', principalId: 'user-1' }] })
        const original = host.deps.writeFileAtomic
        let failed = false
        host.deps.writeFileAtomic = (path, data, meta) => {
            const payload = JSON.parse(data)
            const fail = point === 'install' && path === PATHS.installConfig
                || point === 'runtime' && path === PATHS.runtimeConfig
                || point === 'committed' && path === PATHS.stackState && payload.transition?.phase === 'committed'
                || point === 'applied' && path === PATHS.stackState && payload.transition?.phase === 'verified'
            if (!failed && fail) { failed = true; throw new Error('simulated disk failure') }
            original(path, data, meta)
        }
        await expect(createStack(host.deps).setPrincipal('main', 'user-2')).rejects.toThrow(/previous owner restored/)
        expect(host.state().transition).toBeUndefined()
        expect(host.state().applied.main.principalId).toBe('user-1')
        expect(host.state().applied.main.assignmentId).not.toBe('1'.repeat(32))
    })
})


describe('post-review fail-closed lifecycle', () => {
    const one = [{ profileId: 'main', principalId: 'user-1' }]
    const putState = (h: ReturnType<typeof fakeHost>, patch: object) => h.files.set(PATHS.stackState, { ...h.files.get(PATHS.stackState)!, data: JSON.stringify({ ...h.state(), ...patch }) })
    it('stops existing containers if startup identity validation fails', async () => {
        const h = fakeHost({ profiles: one })
        putState(h, { applied: { main: { principalId: 'another-user', assignmentId: 'a'.repeat(32) } } })
        await expect(createStack(h.deps).start()).rejects.toThrow(/direct edits/)
        expect([...h.containers.values()].every((c) => !c.running)).toBe(true)
        expect(h.calls).toContain(FENCE)
    })
    it('stops existing containers if supervisor identity validation fails', () => {
        const h = fakeHost({ profiles: one })
        putState(h, { applied: { main: { principalId: 'another-user', assignmentId: 'a'.repeat(32) } } })
        expect(() => createStack(h.deps).superviseOnce(new Map())).toThrow(/direct edits/)
        expect([...h.containers.values()].every((c) => !c.running)).toBe(true)
    })
    it.each(['transition', 'migrationHold'])('keeps egress enforcement active during %s without restarting any container', (kind) => {
        const h = fakeHost({ profiles: one, handlers: [[/check-egress$|apply-egress$/, () => ({ status: 1 })]] })
        putState(h, { [kind]: kind === 'transition' ? { phase: 'committed' } : true })
        createStack(h.deps).superviseOnce(new Map())
        expect(h.containers.get('abp-browser-main')!.running).toBe(false)
        expect(h.calls.some((c) => c.startsWith('docker start'))).toBe(false)
    })
    it('takes the operations lock for autonomous startup', async () => {
        const h = fakeHost({ profiles: one })
        const release = await h.deps.opLock()
        await expect(createStack(h.deps).start()).rejects.toThrow(/another/)
        expect(h.calls).toEqual([])
        release()
        await createStack(h.deps).start()
    })
    it('delegated startup preserves the lock-owner state and config, and never opens admission', async () => {
        const h = fakeHost({ profiles: one })
        const options = JSON.parse(h.files.get(PATHS.installConfig)!.data)
        const identity = { main: { principalId: 'user-1', assignmentId: options.profiles[0].assignmentId } }
        h.files.set(PATHS.runtimeConfig, { ...h.files.get(PATHS.runtimeConfig)!, data: JSON.stringify({ ...options, admissionHold: true }) })
        h.files.set('/run/abp-stack-start-request', { data: JSON.stringify({ identity, images: h.state().current }), mode: 0o600, owner: 'root', group: 'root' })
        const before = h.files.get(PATHS.stackState)!.data
        const config = h.files.get(PATHS.runtimeConfig)!.data
        let opened = false
        h.deps.openAdmission = async () => { opened = true; return true }
        const release = await h.deps.opLock()
        await createStack(h.deps).start()
        release()
        expect(h.files.get(PATHS.stackState)!.data).toBe(before)
        expect(h.files.get(PATHS.runtimeConfig)!.data).toBe(config)
        expect(opened).toBe(false)
    })
    it('never copies an already migrated legacy source to another owner', async () => {
        const h = fakeHost({ profiles: one })
        h.volumes.set('abp-profile-main', { 'ai.saycode.abp': 'stack' })
        putState(h, { migrations: [{ source: 'abp-profile-main', target: profileVolumeName('main', 'user-x'), phase: 'verified' }] })
        await expect(createStack(h.deps).migrateLegacyProfile('main', 'user-y', true)).rejects.toThrow(/already has a migration owner/)
        expect(h.calls.some((c) => c.startsWith('docker run'))).toBe(false)
    })
})


describe('offline contract upgrade and migration recovery', () => {
    it('stages compatible images with legacy data preserved and no container start, so migration can run', async () => {
        const h = fakeHost({ profiles: [{ profileId: 'main', principalId: 'user-1' }], handlers: [
            [/^docker volume ls -q$/, () => ({ stdout: 'abp-profile-main' })],
        ] })
        await createStack(h.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_NEW }, noStart: true })
        expect(h.state().current).toEqual({ runtime: RUNTIME_NEW, browser: BROWSER_NEW })
        await createStack(h.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_NEW }, noStart: true })
        expect(h.state().previous).toEqual({ runtime: RUNTIME_OLD, browser: BROWSER_OLD })
        expect(h.calls.some((c) => /volume rm|docker start|systemctl start/.test(c))).toBe(false)
        expect([...h.containers.values()].every((c) => !c.running)).toBe(true)
    })
    it('stops and removes the journaled copier left by a crash before resuming the same owner', async () => {
        const h = fakeHost({ profiles: [{ profileId: 'main', principalId: 'user-1' }] })
        const source = 'abp-profile-main', target = profileVolumeName('main', 'old-owner'), name = 'abp-migrate-test'
        h.volumes.set(source, { 'ai.saycode.abp': 'stack' })
        h.volumes.set(target, Object.fromEntries(profileVolumeLabels('main', 'old-owner').map((l: string) => l.split('='))))
        h.containers.set(name, { running: true, image: BROWSER_OLD, mounts: [source, target] })
        h.files.set(PATHS.stackState, { ...h.files.get(PATHS.stackState)!, data: JSON.stringify({ ...h.state(), migrationHold: true,
            migrations: [{ id: 'test', source, target, profileId: 'main', volumeLabels: profileVolumeLabels('main', 'old-owner'), phase: 'copying' }] }) })
        const run = h.deps.run
        h.deps.run = (cmd, args, opts) => {
            if (cmd === 'docker' && args[0] === 'ps') {
                if (args.includes('label=ai.saycode.abp=stack')) return { status: 0, stdout: h.containers.has(name) ? name : '', stderr: '' }
                if (args.some((a) => a.startsWith('volume='))) return { status: 0, stdout: h.containers.has(name) ? name : '', stderr: '' }
            }
            if (cmd === 'docker' && args[0] === 'run') {
                expect(h.containers.has(name)).toBe(false)
                expect(args).toContain('--label=ai.saycode.abp=stack')
                expect(args).toContain('--name=abp-migrate-test')
                return { status: 0, stdout: JSON.stringify({ verified: true, sha256: 'f'.repeat(64) }), stderr: '' }
            }
            return run(cmd, args, opts)
        }
        await createStack(h.deps).migrateLegacyProfile('main', 'old-owner', true, true)
        expect(h.state().migrations[0].phase).toBe('verified')
        expect(h.volumes.has(source)).toBe(true)
    })
})


describe('post-review operational recovery', () => {
    it('clears a failed delegated start before automatic rollback and restores normal operations', async () => {
        let active = false
        const h = fakeHost({ profiles: [{ profileId: 'main', principalId: 'user-1' }], handlers: [
            [/^systemctl is-active abp-stack.service$/, () => ({ stdout: active ? 'active' : 'inactive', status: active ? 0 : 3 })],
            [/^systemctl start abp-stack.service$/, () => { active = true; return {} }],
            [/^systemctl stop abp-stack.service$/, () => { active = false; return {} }],
        ] })
        const ready = h.deps.adminReady
        let first = true
        h.deps.adminReady = async () => { if (first) { first = false; throw new Error('new image unhealthy') } return ready() }
        await expect(createStack(h.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_NEW } })).rejects.toThrow(/rolled back/)
        expect(h.files.has('/run/abp-stack-start-request')).toBe(false)
        expect(h.state().current).toEqual({ runtime: RUNTIME_OLD, browser: BROWSER_OLD })
        expect(() => createStack(h.deps).assertStable()).not.toThrow()
        expect(JSON.parse(h.files.get(PATHS.runtimeConfig)!.data).admissionHold).toBe(false)
    })
    it('up verifies an already ready stack without restarting it', async () => {
        const h = fakeHost({ profiles: [{ profileId: 'main', principalId: 'user-1' }], serviceActive: true })
        await createStack(h.deps).up()
        expect(h.calls.some((c) => /systemctl (stop|start)|docker (stop|start)/.test(c))).toBe(false)
    })
    it('durable startup rejection is non-restarting and does not duplicate fence rules', async () => {
        const h = fakeHost({ current: null })
        await expect(createStack(h.deps).start()).rejects.toMatchObject({ exitCode: 78 })
        await expect(createStack(h.deps).start()).rejects.toMatchObject({ exitCode: 78 })
        expect(h.calls.filter((c) => c === FENCE)).toHaveLength(1)
    })
})


describe('installed daemon compatibility', () => {
    it('refuses current-package reuse and image upgrade when the daemon lacks lineage contract 2', async () => {
        const h = fakeHost()
        h.files.delete('/opt/abp/happy/lib/node_modules/@buzzni/happy-cli/scripts/agent-browser/contract.json')
        await expect(createStack(h.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_NEW } })).rejects.toThrow(/Happy package.*contract 2/)
        expect(h.calls.some((c) => c.startsWith('docker load') || c.startsWith('docker create'))).toBe(false)
        await expect(createStack(h.deps).start()).rejects.toThrow(/Happy package.*contract 2/)
        expect([...h.containers.values()].every((c) => !c.running)).toBe(true)
    })

    it('accepts a newer (contract 3) package and images on a dedicated machine', async () => {
        const h = fakeHost({ handlers: [[/ai.saycode.abp.contract/, () => ({ stdout: '3' })]] })
        h.files.set('/opt/abp/happy/lib/node_modules/@buzzni/happy-cli/scripts/agent-browser/contract.json', { data: '{"contractVersion":3}', mode: 0o644, owner: 'root', group: 'root' })
        await expect(createStack(h.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_NEW } })).resolves.not.toThrow()
    })

    it("does not stop a running stack when a supervisor tick lands inside abp-install's package swap (marker briefly absent)", () => {
        const h = fakeHost()
        h.files.delete('/opt/abp/happy/lib/node_modules/@buzzni/happy-cli/scripts/agent-browser/contract.json')
        expect(() => createStack(h.deps).superviseOnce(new Map())).not.toThrow()
        expect([...h.containers.values()].every((c) => c.running)).toBe(true)
    })
})


describe('startup restart intent and error classification', () => {
    it('forced up applies installer inputs even when the old process is ready', async () => {
        const h = fakeHost({ profiles: [{ profileId: 'main', principalId: 'user-1' }], serviceActive: true })
        await createStack(h.deps).up({ restart: true })
        expect(h.calls).toContain('systemctl stop abp-stack.service')
        expect(h.calls).toContain('systemctl start abp-stack.service')
    })
    it('keeps transient egress and readiness failures restartable after stopping containers', async () => {
        const h = fakeHost({ handlers: [[/check-egress$|apply-egress$/, () => ({ status: 1 })]] })
        try { await createStack(h.deps).start(); throw new Error('should reject') }
        catch (error: any) { expect(error.message).toMatch(/egress/); expect(error.exitCode).not.toBe(78) }
        expect([...h.containers.values()].every((c) => !c.running)).toBe(true)
        const delayed = fakeHost()
        delayed.deps.adminReady = async () => { throw new Error('temporarily unavailable') }
        try { await createStack(delayed.deps).start(); throw new Error('should reject') }
        catch (error: any) { expect(error.message).toMatch(/temporarily unavailable/); expect(error.exitCode).not.toBe(78) }
    })
})

describe('shared machine profiles (add-profile, remove-profile)', () => {
    const U1 = sharedProfileId('user-1')
    const U2 = sharedProfileId('user-2')
    const U3 = sharedProfileId('user-3')
    const installed = (host: ReturnType<typeof fakeHost>) => JSON.parse(host.files.get(PATHS.installConfig)!.data)
    const runtimeJson = (host: ReturnType<typeof fakeHost>) => JSON.parse(host.files.get(PATHS.runtimeConfig)!.data)
    const stopsOf = (host: ReturnType<typeof fakeHost>, container: string) => host.calls.filter((line) => new RegExp(`^docker (stop|kill|rm|restart) .*${container}$`).test(line))

    it("adds a user's profile in the lowest free slot: its browser, then a new Runtime, leaving the other browsers running", async () => {
        const host = fakeHost({ shared: [['user-1', 0], ['user-2', 2]], serviceActive: true })
        const result = await createStack(host.deps).addProfile('user-3')
        expect(result).toMatchObject({ changed: true, profileId: U3, networkSlot: 1 })
        const profile = installed(host).profiles.find((p: any) => p.principalId === 'user-3')
        expect(profile).toMatchObject({ profileId: U3, networkSlot: 1, assignmentId: expect.stringMatching(/^[0-9a-f]{32}$/) })
        const { calls } = host
        const fence = indexOf(calls, FENCE)
        const network = indexOf(calls, /^docker network create .*br-abp-s1 abp-net-s1$/)
        const browser = indexOf(calls, new RegExp(`^docker create --name=abp-browser-${U3} `))
        const runtimeGone = indexOf(calls, 'docker rm -f abp-runtime')
        const runtime = indexOf(calls, /^docker create --name=abp-runtime /)
        expect(fence).toBeGreaterThanOrEqual(0)
        expect(fence).toBeLessThan(network)
        expect(network).toBeLessThan(browser)
        expect(browser).toBeLessThan(runtimeGone)
        expect(runtimeGone).toBeLessThan(runtime)
        expect(calls[runtime]).toContain('--network=abp-runtime-net')
        expect(calls.filter((line) => /^docker network connect .* abp-runtime$/.test(line))).toHaveLength(3)
        expect(host.volumes.has(profileVolumeName(U3, 'user-3'))).toBe(true)
        expect(stopsOf(host, `abp-browser-${U1}`)).toEqual([])
        expect(stopsOf(host, `abp-browser-${U2}`)).toEqual([])
        expect(host.containers.get(`abp-browser-${U3}`)?.running).toBe(true)
        expect(runtimeJson(host)).toMatchObject({ tenancyMode: 'shared', admissionHold: false })
        expect(runtimeJson(host).profiles.map((p: any) => p.profileId)).toEqual([U1, U2, U3])
        expect(host.state().profileOp).toBeUndefined()
        expect(host.state().applied[U3]).toEqual({ principalId: 'user-3', assignmentId: profile.assignmentId })
        expect(host.state().history.at(-1)).toMatchObject({ action: 'add-profile', result: 'ready', profileId: U3 })
        expect(calls.at(-1)).toBe(UNFENCE)
    })

    it('leaves an existing profile as it is', async () => {
        const host = fakeHost({ shared: [['user-1', 0]], serviceActive: true })
        expect(await createStack(host.deps).addProfile('user-1')).toMatchObject({ changed: false, profileId: U1 })
        expect(host.calls.some((line) => line.startsWith('docker create'))).toBe(false)
    })

    it('refuses a ninth profile, and a profile the memory cannot hold, changing nothing', async () => {
        const full = fakeHost({ shared: Array.from({ length: 8 }, (_, i) => [`user-${i + 10}`, i] as [string, number]), serviceActive: true, memory: { totalBytes: 64 * 2 ** 30, availableBytes: 40 * 2 ** 30 } })
        await expect(createStack(full.deps).addProfile('user-3')).rejects.toThrow(/at most 8/)
        const low = fakeHost({ shared: [['user-1', 0]], serviceActive: true, memory: { totalBytes: 16 * 2 ** 30, availableBytes: 2 * 2 ** 30 } })
        await expect(createStack(low.deps).addProfile('user-3')).rejects.toThrow(/memory/)
        // 16 GiB less the 4 GiB session reserve holds the Runtime (1 GiB) and five 2 GiB browsers, not six.
        const budget = fakeHost({ shared: [0, 1, 2, 3, 4].map((i) => [`user-${i + 10}`, i] as [string, number]), serviceActive: true })
        await expect(createStack(budget.deps).addProfile('user-3')).rejects.toThrow(/memory/)
        for (const host of [full, low, budget]) {
            expect(host.calls.some((line) => line.startsWith('docker create') || line === FENCE)).toBe(false)
            expect(host.state().history).toEqual([])
        }
    })

    it("removes a user's profile: a new Runtime without it, then its browser and network; the volume stays and only later attestations bring it back", async () => {
        const host = fakeHost({ shared: [['user-1', 0], ['user-2', 2]], serviceActive: true })
        expect(await createStack(host.deps).removeProfile('user-2')).toMatchObject({ changed: true, profileId: U2 })
        const { calls } = host
        const runtime = indexOf(calls, /^docker create --name=abp-runtime /)
        const browserGone = indexOf(calls, `docker rm -f abp-browser-${U2}`)
        expect(runtime).toBeGreaterThanOrEqual(0)
        expect(runtime).toBeLessThan(browserGone)
        expect(calls.slice(browserGone)).toContain('docker network rm abp-net-s2')
        expect(host.volumes.has(profileVolumeName(U2, 'user-2'))).toBe(true)
        expect(stopsOf(host, `abp-browser-${U1}`)).toEqual([])
        expect(installed(host).profiles.map((p: any) => p.principalId)).toEqual(['user-1'])
        expect(runtimeJson(host).profileTombstones).toEqual([{ principalId: 'user-2', removedAtMs: 1_000_000 }])
        expect(host.state().history.at(-1)).toMatchObject({ action: 'remove-profile', result: 'ready', profileId: U2 })
        // Added again: the same volume, a new assignment, the tombstone gone.
        await createStack(host.deps).addProfile('user-2')
        expect(installed(host).profiles.find((p: any) => p.principalId === 'user-2').assignmentId).not.toBe('2'.repeat(32))
        expect(runtimeJson(host).profileTombstones).toEqual([{ principalId: 'user-2', removedAtMs: 1_000_000 }])
    })

    it('--block keeps a removed user from coming back on first use (only add-profile brings them back)', async () => {
        const host = fakeHost({ shared: [['user-1', 0], ['user-2', 2]], serviceActive: true })
        await createStack(host.deps).removeProfile('user-2', { block: true })
        expect(runtimeJson(host).profileTombstones).toEqual([{ principalId: 'user-2', removedAtMs: Number.MAX_SAFE_INTEGER }])
    })

    it('rolls a failed addition back to the previous profiles (the new browser never comes up)', async () => {
        const host = fakeHost({ shared: [['user-1', 0]], serviceActive: true, brokenBrowsers: [U3] })
        await expect(createStack(host.deps).addProfile('user-3')).rejects.toThrow(/add-profile failed/)
        expect(installed(host).profiles.map((p: any) => p.principalId)).toEqual(['user-1'])
        expect(runtimeJson(host).profiles.map((p: any) => p.profileId)).toEqual([U1])
        expect(host.containers.has(`abp-browser-${U3}`)).toBe(false)
        expect(runtimeJson(host).admissionHold).toBe(false)
        expect(host.state().profileOp).toBeUndefined()
        expect(host.state().history.at(-1)).toMatchObject({ action: 'add-profile', result: 'rolled-back', profileId: U3 })
    })

    it("goes ahead while another user's browser is broken: only the changed profile's browser must come up", async () => {
        const host = fakeHost({ shared: [['user-1', 0], ['user-2', 2]], serviceActive: true, brokenBrowsers: [U1] })
        host.containers.get(`abp-browser-${U1}`)!.running = false
        await createStack(host.deps).addProfile('user-3')
        await createStack(host.deps).removeProfile('user-2')
        expect(installed(host).profiles.map((p: any) => p.principalId)).toEqual(['user-1', 'user-3'])
        expect(runtimeJson(host).admissionHold).toBe(false)
    })

    const leaveOp = (host: ReturnType<typeof fakeHost>, profileOp: Record<string, unknown>, installProfiles?: unknown[]) => {
        const before = installed(host)
        host.files.set(PATHS.stackState, { data: JSON.stringify({ ...host.state(), applied: { [U1]: { principalId: 'user-1', assignmentId: '1'.repeat(32) } }, profileOp: { before, ...profileOp } }), mode: 0o600, owner: 'root', group: 'root' })
        if (installProfiles) host.files.set(PATHS.installConfig, { data: JSON.stringify({ ...before, profiles: installProfiles }), mode: 0o600, owner: 'root', group: 'root' })
        return before
    }
    const U3profile = { profileId: U3, principalId: 'user-3', assignmentId: '9'.repeat(32), networkSlot: 1 }

    it('holds other operations while a change is unfinished, and a service start settles it (before the commit: the previous profiles)', async () => {
        const host = fakeHost({ shared: [['user-1', 0]], serviceActive: true, handlers: [[/^docker network inspect/, () => ({ status: 1 })]] })
        const before = leaveOp(host, { op: 'add', principalId: 'user-3', profileId: U3, phase: 'started' })
        host.files.set(PATHS.installConfig, { data: JSON.stringify({ ...before, profiles: [...before.profiles, U3profile] }), mode: 0o600, owner: 'root', group: 'root' })
        await expect(createStack(host.deps).addProfile('user-4')).rejects.toThrow(/unfinished add-profile/)
        await createStack(host.deps).start()
        expect(installed(host).profiles.map((p: any) => p.principalId)).toEqual(['user-1'])
        expect(host.state().profileOp).toBeUndefined()
        expect(host.state().history.some((entry: any) => entry.action === 'settle-profile-change' && entry.adopted === 'before')).toBe(true)
    })

    it('a service start keeps a committed change (its Runtime may already serve it)', async () => {
        const host = fakeHost({ shared: [['user-1', 0]], serviceActive: true, handlers: [[/^docker network inspect/, () => ({ status: 1 })]] })
        const before = leaveOp(host, { op: 'add', principalId: 'user-3', profileId: U3, phase: 'committed' })
        host.files.set(PATHS.installConfig, { data: JSON.stringify({ ...before, profiles: [...before.profiles, U3profile] }), mode: 0o600, owner: 'root', group: 'root' })
        host.volumes.set(profileVolumeName(U3, 'user-3'), Object.fromEntries(profileVolumeLabels(U3, 'user-3').map((l: string) => l.split('='))))
        await createStack(host.deps).start()
        expect(installed(host).profiles.map((p: any) => p.principalId)).toEqual(['user-1', 'user-3'])
        expect(host.state().profileOp).toBeUndefined()
    })

    it('keeps supervising the other browsers after a change that failed for good, and recover-profiles still puts the previous profiles back', async () => {
        const supervised = fakeHost({ shared: [['user-1', 0]] })
        leaveOp(supervised, { op: 'add', principalId: 'user-3', profileId: U3, phase: 'failed' })
        supervised.containers.get(`abp-browser-${U1}`)!.running = false
        createStack(supervised.deps).superviseOnce(new Map())
        expect(supervised.calls).toContain(`docker start abp-browser-${U1}`)
        const active = fakeHost({ shared: [['user-1', 0]] })
        leaveOp(active, { op: 'add', principalId: 'user-3', profileId: U3, phase: 'committed' })
        active.containers.get(`abp-browser-${U1}`)!.running = false
        createStack(active.deps).superviseOnce(new Map())
        expect(active.calls.some((line) => line.startsWith('docker start'))).toBe(false)
        const host = fakeHost({ shared: [['user-1', 0]], serviceActive: true })
        leaveOp(host, { op: 'add', principalId: 'user-3', profileId: U3, phase: 'failed' }, [...installed(host).profiles, U3profile])
        await createStack(host.deps).recoverProfiles()
        expect(installed(host).profiles.map((p: any) => p.principalId)).toEqual(['user-1'])
        expect(host.state().history.at(-1)).toMatchObject({ action: 'recover-profiles', result: 'ready' })
    })

    it('abp-stack up --restart settles a change that failed for good (the recovery the error names)', async () => {
        const host = fakeHost({ shared: [['user-1', 0]], serviceActive: true })
        leaveOp(host, { op: 'add', principalId: 'user-3', profileId: U3, phase: 'failed' }, [...installed(host).profiles, U3profile])
        await createStack(host.deps).up({ restart: true })
        expect(installed(host).profiles.map((p: any) => p.principalId)).toEqual(['user-1'])
        expect(host.state().profileOp).toBeUndefined()
        expect(runtimeJson(host).admissionHold).toBe(false)
    })

    it('still checks every browser volume and mount after a change, only not that the others are connected', async () => {
        const host = fakeHost({ shared: [['user-1', 0]], serviceActive: true })
        await createStack(host.deps).addProfile('user-3')
        expect(host.calls).toContain(`docker inspect -f {{json .Mounts}} abp-browser-${U1}`)
    })

    it('a failure before the Runtime is touched cleans up only the new browser: no Runtime restart for everyone', async () => {
        const host = fakeHost({ shared: [['user-1', 0]], serviceActive: true, handlers: [[/^docker network create .*abp-net-s1$/, () => ({ status: 1, stderr: 'Pool overlaps' })]] })
        await expect(createStack(host.deps).addProfile('user-3')).rejects.toThrow(/add-profile failed/)
        expect(host.calls.some((line) => /^docker (rm -f|create --name=) ?abp-runtime/.test(line) || line === 'docker rm -f abp-runtime')).toBe(false)
        expect(host.calls.at(-1)).toBe(UNFENCE)
        expect(host.state().profileOp).toBeUndefined()
        expect(host.state().history.at(-1)).toMatchObject({ action: 'add-profile', result: 'rolled-back' })
    })

    it('a removal that fails after its commit goes forward, never back to a user whose sessions already ended', async () => {
        const host = fakeHost({ shared: [['user-1', 0], ['user-2', 2]], serviceActive: true, handlers: [[new RegExp(`^docker rm -f abp-browser-${U2}$`), () => ({ status: 1 })]] })
        await createStack(host.deps).removeProfile('user-2')
        expect(installed(host).profiles.map((p: any) => p.principalId)).toEqual(['user-1'])
        expect(host.state().profileOp).toBeUndefined()
    })

    it('changes containers only while the stack service runs (not after down or emergency-stop)', async () => {
        const stopped = fakeHost({ shared: [['user-1', 0], ['user-2', 2]], serviceActive: false })
        await expect(createStack(stopped.deps).removeProfile('user-2')).rejects.toThrow(/abp-stack up/)
        const emergency = fakeHost({ shared: [['user-1', 0]], serviceActive: true })
        emergency.files.set('/run/abp-stack-emergency', { data: '1', mode: 0o600, owner: 'root', group: 'root' })
        await expect(createStack(emergency.deps).addProfile('user-3')).rejects.toThrow(/emergency/)
    })

    it("re-adding a removed user keeps the removal time, so their chats from before stay retired (a block becomes a removal now)", async () => {
        const host = fakeHost({ shared: [['user-1', 0], ['user-2', 2]], serviceActive: true })
        await createStack(host.deps).removeProfile('user-2', { block: true })
        await createStack(host.deps).addProfile('user-2')
        expect(runtimeJson(host).profileTombstones).toEqual([{ principalId: 'user-2', removedAtMs: 1_000_000 }])
    })

    it('is for shared machines only, and a shared machine refuses set-principal', async () => {
        const dedicated = fakeHost({ serviceActive: true })
        await expect(createStack(dedicated.deps).addProfile('user-3')).rejects.toThrow(/shared machine/)
        await expect(createStack(dedicated.deps).removeProfile('user-2')).rejects.toThrow(/shared machine/)
        const shared = fakeHost({ shared: [['user-1', 0]], serviceActive: true })
        await expect(createStack(shared.deps).setPrincipal(U1, 'user-9')).rejects.toThrow(/add-profile|remove-profile/)
    })

    it('lists the profiles with their slot, volume and container state, and the removed users', async () => {
        const host = fakeHost({ shared: [['user-1', 0], ['user-2', 2]], serviceActive: true })
        await createStack(host.deps).removeProfile('user-2')
        const list = createStack(host.deps).listProfiles()
        expect(list.profiles).toEqual([{ profileId: U1, principalId: 'user-1', networkSlot: 0, assignmentId: '1'.repeat(32), volume: profileVolumeName(U1, 'user-1'), running: true }])
        expect(list.removed).toEqual([{ principalId: 'user-2', removedAtMs: 1_000_000, blocked: false }])
        expect(list.capacity).toMatchObject({ max: 8 })
    })
})

describe('first-use profile requests (the abp-stack service)', () => {
    const U3 = sharedProfileId('user-3')

    it('adds the profile a session asked for', async () => {
        const host = fakeHost({ shared: [['user-1', 0]], serviceActive: true, requests: [{ principalId: 'user-3', requestedAtMs: 1 }] })
        expect(await createStack(host.deps).provisionRequestedProfiles(new Map())).toEqual({ added: ['user-3'] })
        expect(JSON.parse(host.files.get(PATHS.installConfig)!.data).profiles.map((p: any) => p.profileId)).toContain(U3)
    })

    it('refuses a request the machine cannot hold, with the reason, and does not retry it meanwhile', async () => {
        const host = fakeHost({ shared: [['user-1', 0]], serviceActive: true, requests: [{ principalId: 'user-3', requestedAtMs: 1 }], memory: { totalBytes: 16 * 2 ** 30, availableBytes: 2 ** 30 } })
        expect(await createStack(host.deps).provisionRequestedProfiles(new Map())).toEqual({ refused: [{ principalId: 'user-3', reason: 'memory' }] })
        expect(host.refusals).toEqual([{ principalId: 'user-3', reason: 'memory', retryAfterMs: 600_000 }])
        const full = fakeHost({ shared: Array.from({ length: 8 }, (_, i) => [`user-${i + 10}`, i] as [string, number]), serviceActive: true, requests: [{ principalId: 'user-3', requestedAtMs: 1 }], memory: { totalBytes: 64 * 2 ** 30, availableBytes: 40 * 2 ** 30 } })
        await createStack(full.deps).provisionRequestedProfiles(new Map())
        expect(full.refusals[0]).toMatchObject({ principalId: 'user-3', reason: 'capacity' })
    })

    it('leaves requests for later while another operation holds the lock, and backs off a failed addition', async () => {
        const host = fakeHost({ shared: [['user-1', 0]], serviceActive: true, requests: [{ principalId: 'user-3', requestedAtMs: 1 }] })
        const release = await host.deps.opLock()
        expect(await createStack(host.deps).provisionRequestedProfiles(new Map())).toEqual({ busy: true })
        release()
        const failing = fakeHost({ shared: [['user-1', 0]], serviceActive: true, requests: [{ principalId: 'user-3', requestedAtMs: 1 }], brokenBrowsers: [sharedProfileId('user-3')] })
        const backoff = new Map()
        expect(await createStack(failing.deps).provisionRequestedProfiles(backoff)).toEqual({ refused: [{ principalId: 'user-3', reason: 'failed' }] })
        const calls = failing.calls.length
        expect(await createStack(failing.deps).provisionRequestedProfiles(backoff)).toEqual({})
        expect(failing.calls.length).toBe(calls)
    })

    it('refuses a blocked user, and reports a failed addition to the broker instead of retrying it every minute', async () => {
        const blocked = fakeHost({ shared: [['user-1', 0]], serviceActive: true, requests: [{ principalId: 'user-3', requestedAtMs: 1 }] })
        blocked.files.set(PATHS.installConfig, { data: JSON.stringify({ ...JSON.parse(blocked.files.get(PATHS.installConfig)!.data), profileTombstones: [{ principalId: 'user-3', removedAtMs: Number.MAX_SAFE_INTEGER }] }), mode: 0o600, owner: 'root', group: 'root' })
        expect(await createStack(blocked.deps).provisionRequestedProfiles(new Map())).toEqual({ refused: [{ principalId: 'user-3', reason: 'blocked' }] })
        expect(blocked.calls.some((line) => line.startsWith('docker create'))).toBe(false)
        const failing = fakeHost({ shared: [['user-1', 0]], serviceActive: true, requests: [{ principalId: 'user-3', requestedAtMs: 1 }], brokenBrowsers: [sharedProfileId('user-3')] })
        await createStack(failing.deps).provisionRequestedProfiles(new Map())
        expect(failing.refusals).toEqual([{ principalId: 'user-3', reason: 'failed', retryAfterMs: 600_000 }])
    })

    it('refuses a user whose additions keep failing for longer each time (10, 30, 90 minutes)', async () => {
        const failing = fakeHost({ shared: [['user-1', 0]], serviceActive: true, requests: [{ principalId: 'user-3', requestedAtMs: 1 }], brokenBrowsers: [sharedProfileId('user-3')] })
        const backoff = new Map()
        const stack = createStack(failing.deps)
        await stack.provisionRequestedProfiles(backoff)
        await failing.deps.sleep(600_001)
        await stack.provisionRequestedProfiles(backoff)
        await failing.deps.sleep(1_800_001)
        await stack.provisionRequestedProfiles(backoff)
        expect(failing.refusals.map((r) => r.retryAfterMs)).toEqual([600_000, 1_800_000, 5_400_000])
    })

    it('does not refuse a request when the machine was only busy (drain timed out, nothing changed), and tries again soon', async () => {
        const busy = fakeHost({ shared: [['user-1', 0]], serviceActive: true, requests: [{ principalId: 'user-3', requestedAtMs: 1 }], running: Array(200).fill(1) })
        expect(await createStack(busy.deps).provisionRequestedProfiles(new Map())).toEqual({ busy: true })
        expect(busy.refusals).toEqual([])
    })

    it('asks the service to restart when a change failed for good, so the next start settles it and lifts the fence', async () => {
        let runtimeCreates = 0
        const host = fakeHost({ shared: [['user-1', 0]], serviceActive: true, requests: [{ principalId: 'user-3', requestedAtMs: 1 }], brokenBrowsers: [sharedProfileId('user-3')],
            handlers: [[/^docker create --name=abp-runtime /, () => (++runtimeCreates > 1 ? { status: 1 } : undefined)]] })
        expect(await createStack(host.deps).provisionRequestedProfiles(new Map())).toMatchObject({ restartToSettle: true })
        expect(host.state().profileOp).toMatchObject({ phase: 'failed' })
    })

    it('does nothing on a dedicated machine', async () => {
        const host = fakeHost({ serviceActive: true, requests: [{ principalId: 'user-3', requestedAtMs: 1 }] })
        expect(await createStack(host.deps).provisionRequestedProfiles(new Map())).toEqual({})
    })
})
