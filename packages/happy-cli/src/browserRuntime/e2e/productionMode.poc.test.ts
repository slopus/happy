/**
 * Production-mode Runtime on real containers (S2 smoke): the Runtime reads
 * /etc/abp/runtime.json, verifies the entrypoint flock, issues agent grants on
 * the broker socket, serves admin only on its unix socket, and accepts
 * interactive capabilities only when server-signed (abp2).
 *
 * Installed permissions are reproduced exactly: runtime.json root 0600 on a
 * read-only mount, /run/abp root:abp-session 0750. The Runtime starts as root
 * with only SETUID/SETGID, binds the sockets and drops to its runtime uid.
 *
 * It runs next to the harness stack's Runtime, on its own state volume, and
 * attaches to the same browsers. Socket clients run in helper containers that
 * share the /run/abp volume (unix sockets do not cross the macOS bind mount),
 * as root, as an agent-like user in abp-session, as an outsider, and as the
 * runtime user itself.
 */
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { signServerCapability } from '../auth'
import { INTERACTIVE_CAPABILITY_ISSUER, type RequestId } from '../contracts'
import { RuntimeClient } from '../runtimeClient'
import { MACHINE, PRINCIPAL_A, PROFILE_A, SITE_A, SITE_B, WORKSPACE, startPocStack, type PocStack } from './pocStack'

const abpDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/browser-poc/.abp')
const docker = (args: string[], input?: string) => execFileSync('docker', args, { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }).trim()

const RUNTIME_UID = 10870
const ABP_SESSION_GID = 10880
const USERS = {
    root: ['--user', '0:0'],
    agent: ['--user', '10881:10881', '--group-add', String(ABP_SESSION_GID)],
    outsider: ['--user', '10882:10882'],
    runtime: ['--user', `${RUNTIME_UID}:${RUNTIME_UID}`],
} as const

describe('Runtime in production mode', () => {
    let stack: PocStack
    let name: string
    let image: string
    let runtimeUrl: string
    const daemonToken = randomBytes(32).toString('hex')
    const issuer = generateKeyPairSync('ed25519')
    const runVolume = () => `abp-${stack.run}-prod-run`
    const etcVolume = () => `abp-${stack.run}-prod-etc`

    /** One HTTP request over a unix socket in the shared /run/abp volume, from a helper container running as `user`. */
    const socketCall = (user: keyof typeof USERS, socket: string, method: string, path: string, headers: Record<string, string> = {}, body?: unknown): { status: number; body: any } => {
        const script = `const http=require('node:http');const [s,m,p,h,b]=process.argv.slice(1);const r=http.request({socketPath:s,method:m,path:p,headers:JSON.parse(h)},(res)=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>process.stdout.write(JSON.stringify({status:res.statusCode,body:d?JSON.parse(d):{}})))});r.on('error',e=>{process.stdout.write(JSON.stringify({status:0,body:{error:e.code}}))});r.end(b||undefined)`
        const out = docker(['run', '--rm', '--label', `ai.saycode.abp-run=${stack.run}`, ...USERS[user], ...mount(runVolume(), '/run/abp'), '--entrypoint', 'node', image,
            '-e', script, socket, method, path, JSON.stringify({ 'content-type': 'application/json', ...headers }), body === undefined ? '' : JSON.stringify(body)])
        return JSON.parse(out) as { status: number; body: any }
    }
    /**
     * Stand-in for the host bind mounts of H. nocopy: Docker re-applies the image
     * directory's ownership to an empty named volume on every mount, which would
     * undo the installed root:abp-session ownership of /run/abp.
     */
    const mount = (volume: string, target: string, readonly = false) =>
        ['--mount', `type=volume,source=${volume},target=${target},volume-nocopy${readonly ? ',readonly' : ''}`]
    /** Run a shell command inside a throwaway container as root with one volume. */
    const asRoot = (volume: string, target: string, command: string, input?: string) =>
        docker(['run', '--rm', '-i', '--label', `ai.saycode.abp-run=${stack.run}`, '--user', '0:0', ...mount(volume, target), '--entrypoint', 'sh', image, '-c', command], input)

    beforeAll(async () => {
        stack = await startPocStack()
        image = docker(['inspect', '-f', '{{.Config.Image}}', stack.env.containers.runtime])
        name = `abp-${stack.run}-runtime-prod`
        const config = JSON.stringify({
            authMode: 'production', machineId: MACHINE, workspaceId: WORKSPACE,
            profiles: [{ profileId: PROFILE_A, principalId: PRINCIPAL_A, cdpHttpUrl: 'http://browser-a:9223', instanceUrl: 'http://browser-a:9224/instance' }],
            trustedIssuers: [{ kid: 'k1', publicKeyPem: issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
            sites: [{ origin: SITE_A }, { origin: SITE_B }],
            runtimePort: 8787,
            brokerSocketGid: ABP_SESSION_GID,
            daemonTokenSha256: createHash('sha256').update(daemonToken).digest('hex'),
        })
        for (const volume of [`abp-${stack.run}-prod-state`, runVolume(), etcVolume()]) docker(['volume', 'create', '--label', `ai.saycode.abp-run=${stack.run}`, volume])
        // What abp-install lays down on H: root-only config, and a socket dir only root and abp-session can enter.
        asRoot(etcVolume(), '/etc/abp', 'umask 077 && cat > /etc/abp/runtime.json && chown 0:0 /etc/abp/runtime.json && chmod 0600 /etc/abp/runtime.json && chmod 0755 /etc/abp', config)
        asRoot(runVolume(), '/run/abp', `chown 0:${ABP_SESSION_GID} /run/abp && chmod 0750 /run/abp`)
        docker(['run', '-d', '--name', name, '--label', `ai.saycode.abp-run=${stack.run}`, '--network', `abp-${stack.run}-a`,
            '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--security-opt', 'no-new-privileges',
            '--read-only', '--tmpfs', '/tmp:rw,size=64m',
            '-v', `abp-${stack.run}-prod-state:/var/lib/abp`, ...mount(runVolume(), '/run/abp'), ...mount(etcVolume(), '/etc/abp', true),
            '-v', `${join(abpDir, 'runtime.mjs')}:/app/runtime.mjs:ro`,
            '-e', 'ABP_STATE_DIR=/var/lib/abp/state', '-e', 'ABP_CONFIG_FILE=/etc/abp/runtime.json',
            '-p', '127.0.0.1::8787', image])
        runtimeUrl = `http://127.0.0.1:${docker(['port', name, '8787']).split('\n')[0].split(':').at(-1)}`
        const deadline = Date.now() + 60_000
        for (;;) {
            const ready = await fetch(`${runtimeUrl}/v1/ready`).then((r) => r.status).catch(() => 0)
            if (ready === 200) break
            if (Date.now() > deadline) throw new Error(`production Runtime not ready: ${execFileSync('sh', ['-c', 'docker logs "$0" 2>&1 | tail -20', name], { encoding: 'utf8' })}`)
            await new Promise((r) => setTimeout(r, 500))
        }
    }, 300_000)
    afterAll(() => stack?.down({ purge: true }))

    it('runs with the installed ownership: root-only config, root:abp-session socket dir, no capability left after start', async () => {
        expect(docker(['exec', name, 'stat', '-c', '%n %u %g %a', '/etc/abp/runtime.json', '/run/abp', '/run/abp/broker.sock', '/run/abp/admin.sock']).split('\n')).toEqual([
            '/etc/abp/runtime.json 0 0 600',
            `/run/abp 0 ${ABP_SESSION_GID} 750`,
            `/run/abp/broker.sock 0 ${ABP_SESSION_GID} 660`,
            '/run/abp/admin.sock 0 0 600',
        ])
        const status = docker(['exec', name, 'cat', '/proc/1/status'])
        expect(status).toMatch(/^Name:\s+node$/m)
        expect(status).toMatch(new RegExp(`^Uid:\\s+${RUNTIME_UID}\\s+${RUNTIME_UID}\\s+${RUNTIME_UID}\\s+${RUNTIME_UID}$`, 'm'))
        expect(status).toMatch(/^Groups:\s*$/m)
        for (const set of ['CapPrm', 'CapEff', 'CapAmb']) expect(status).toMatch(new RegExp(`^${set}:\\s+0+$`, 'm'))
        // The dropped Runtime cannot read its own config again.
        expect(() => docker(['exec', '--user', `${RUNTIME_UID}:${RUNTIME_UID}`, name, 'cat', '/etc/abp/runtime.json'])).toThrow()
    })

    it('keeps only the intended descriptors after dropping root: no config, one flock, the two socket listeners', () => {
        // The dropped process is not dumpable: a root helper with SYS_PTRACE in its pid namespace reads /proc/1.
        const audit = docker(['run', '--rm', '--label', `ai.saycode.abp-run=${stack.run}`, '--pid', `container:${name}`, '--user', '0:0',
            '--cap-drop', 'ALL', '--cap-add', 'SYS_PTRACE', '--entrypoint', 'sh', image, '-c',
            'for f in /proc/1/fd/*; do echo "fd $(readlink "$f")"; done; grep " /run/abp/" /proc/1/net/unix'])
        const targets = audit.split('\n').filter((line) => line.startsWith('fd ')).map((line) => line.slice(3))
        expect(targets.filter((target) => target.startsWith('/etc/abp'))).toEqual([])
        expect(targets.filter((target) => target === '/var/lib/abp/state/runtime.flock')).toHaveLength(1)
        expect(targets.filter((target) => !/^(\/dev\/null|pipe:|anon_inode:|socket:|\/var\/lib\/abp\/state\/)/.test(target))).toEqual([])
        // /proc/net/unix: "<addr>: <refs> <proto> <flags> <type> <state> <inode> <path>"; state 01 = listening.
        const listeners = audit.split('\n').filter((line) => !line.startsWith('fd ')).map((line) => line.trim().split(/\s+/))
            .map((fields) => ({ state: fields[5], inode: fields[6], path: fields[7] }))
        expect(listeners.map((listener) => `${listener.path}:${listener.state}`).sort()).toEqual(['/run/abp/admin.sock:01', '/run/abp/broker.sock:01'])
        for (const listener of listeners) expect(targets).toContain(`socket:[${listener.inode}]`)
    })

    it('holds the writer flock, publishes no admin port and serves readiness', async () => {
        const stderr = execFileSync('sh', ['-c', 'docker logs "$0" 2>&1', name], { encoding: 'utf8' })
        expect(stderr).toMatch(new RegExp(`dropped root uid=${RUNTIME_UID} gid=${RUNTIME_UID}`))
        expect(stderr).toMatch(/listening .*mode=production admin=socket broker=socket flock=true/)
        expect(docker(['port', name])).not.toMatch(/8788/)
        expect(await (await fetch(`${runtimeUrl}/v1/ready`)).json()).toEqual({ ok: true, ready: true, checks: { browsers: true, writerLock: true, disk: true, revocations: true } })
        const metrics = socketCall('root', '/run/abp/admin.sock', 'GET', '/admin/metrics')
        expect(metrics.status).toBe(200)
        expect(metrics.body.result.browsers).toEqual({ [PROFILE_A]: { connected: true } })
    })

    it('lets only abp-session members reach the broker and only root reach admin', () => {
        const daemon = { 'x-abp-daemon-token': daemonToken }
        expect(socketCall('agent', '/run/abp/broker.sock', 'POST', '/v1/sessions/register', daemon, { schemaVersion: 1 }).status).toBe(200)
        expect(socketCall('outsider', '/run/abp/broker.sock', 'POST', '/v1/sessions/register', daemon, { schemaVersion: 1 })).toEqual({ status: 0, body: { error: 'EACCES' } })
        for (const user of ['agent', 'outsider', 'runtime'] as const) {
            expect(socketCall(user, '/run/abp/admin.sock', 'GET', '/admin/metrics')).toEqual({ status: 0, body: { error: 'EACCES' } })
        }
        expect(socketCall('root', '/run/abp/admin.sock', 'GET', '/admin/metrics').status).toBe(200)
    })

    it('issues a session grant over the broker socket and serves the task API with it', async () => {
        const daemon = { 'x-abp-daemon-token': daemonToken }
        const broker = (method: string, path: string, headers: Record<string, string>, body?: unknown) => socketCall('agent', '/run/abp/broker.sock', method, path, headers, body)
        expect(broker('POST', '/v1/sessions/register', {}, { schemaVersion: 1 }).status).toBe(401)
        const registered = broker('POST', '/v1/sessions/register', daemon, { schemaVersion: 1 })
        expect(registered.status).toBe(200)
        const { registrationId, sessionSecret } = registered.body.result
        expect(broker('POST', '/v1/sessions/bind', daemon, { schemaVersion: 1, registrationId, agentSessionId: 'session-prod' }).status).toBe(200)
        const granted = broker('POST', '/v1/agent-grants', { 'x-abp-session-secret': sessionSecret }, { schemaVersion: 1, agentSessionId: 'session-prod', profileId: PROFILE_A })
        expect(granted.status).toBe(200)
        const agent = new RuntimeClient({ baseUrl: runtimeUrl, token: granted.body.result.token })
        const { taskSpaceId } = await agent.createSpace({ profileId: PROFILE_A, requestId: randomUUID() as RequestId })
        const task = await agent.createTask({ taskSpaceId, requestId: randomUUID() as RequestId })

        // Interactive: server-signed abp2 works, the harness's abp1 HMAC capability does not.
        const now = Date.now() - 5_000
        const capability = signServerCapability({ kind: 'interactive', capabilityId: `cap-${randomUUID()}`, principalId: PRINCIPAL_A, workspaceId: WORKSPACE,
            machineId: MACHINE, viewerSessionId: 'viewer', profileId: PROFILE_A, operations: ['getTask', 'approve'], issuedAtMs: now, expiresAtMs: now + 240_000,
            aud: MACHINE, iss: INTERACTIVE_CAPABILITY_ISSUER }, { kid: 'k1', privateKey: issuer.privateKey })
        expect((await new RuntimeClient({ baseUrl: runtimeUrl, token: capability }).getTask({ taskId: task.taskId })).taskId).toBe(task.taskId)
        await expect(new RuntimeClient({ baseUrl: runtimeUrl, token: stack.mintInteractive() }).getTask({ taskId: task.taskId })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

        expect(broker('POST', '/v1/sessions/revoke', daemon, { schemaVersion: 1, agentSessionId: 'session-prod' }).body.result).toEqual({ revoked: true, grants: 1 })
        await expect(agent.getTask({ taskId: task.taskId })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
        expect(broker('POST', '/v1/agent-grants', { 'x-abp-session-secret': sessionSecret }, { schemaVersion: 1, agentSessionId: 'session-prod', profileId: PROFILE_A }).status).toBe(401)
    }, 120_000)
})
