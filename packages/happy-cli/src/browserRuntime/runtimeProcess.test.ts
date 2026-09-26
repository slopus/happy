/**
 * Root start failure (production launcher): if dropping root fails, the
 * Runtime must stop before it opens the state volume, contacts a browser or
 * serves the task API, and must not keep the sockets it bound as root.
 */
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PrivilegeOps } from './privilegeDrop'
import { runRuntime } from './runtimeProcess'

const ENV_KEYS = ['ABP_STATE_DIR', 'ABP_CONFIG_FILE', 'ABP_KEYS_FILE', 'ABP_PROFILES', 'ABP_RUNTIME_UID', 'ABP_RUNTIME_GID', 'ABP_WRITER_FLOCK'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
    for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key] }
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const listen = (server: Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
const reachable = (target: { port: number } | { path: string }) => new Promise<boolean>((resolve) => {
    const socket = connect(target as never)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
})

async function rootStart(privilege: Partial<PrivilegeOps>) {
    // Short path: unix socket paths are limited to ~104 bytes on macOS.
    const dir = await mkdtemp(join(tmpdir(), 'abp-rp-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const stateDir = join(dir, 'state')
    await mkdir(stateDir)
    let browserRequests = 0
    const browser = createServer((_req, res) => { browserRequests++; res.end('{}') })
    const browserPort = await listen(browser)
    cleanups.push(() => new Promise((resolve) => browser.close(() => resolve())))
    const probe = createServer()
    const runtimePort = await listen(probe)
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    const config = join(dir, 'runtime.json')
    await writeFile(config, JSON.stringify({
        authMode: 'production', machineId: 'machine-h', workspaceId: 'workspace-1',
        profiles: [{ profileId: 'profile-a', principalId: 'user-1', cdpHttpUrl: `http://127.0.0.1:${browserPort}`, instanceUrl: `http://127.0.0.1:${browserPort}/instance` }],
        trustedIssuers: [{ kid: 'k1', publicKeyPem: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
        runtimeHost: '127.0.0.1', runtimePort,
        brokerSocketPath: join(dir, 'broker.sock'), adminSocketPath: join(dir, 'admin.sock'),
        daemonTokenSha256: createHash('sha256').update('synthetic-daemon-token').digest('hex'),
    }), { mode: 0o600 })
    for (const key of ENV_KEYS) delete process.env[key]
    Object.assign(process.env, { ABP_STATE_DIR: stateDir, ABP_CONFIG_FILE: config, ABP_RUNTIME_UID: '10870', ABP_RUNTIME_GID: '10870' })
    const ids = { uid: 0, gid: 0 }
    const ops: PrivilegeOps = {
        getuid: () => ids.uid, geteuid: () => ids.uid, getgid: () => ids.gid, getegid: () => ids.gid,
        setgroups: () => undefined, setgid: (id) => { ids.gid = id }, setuid: (id) => { ids.uid = id },
        readStatus: async () => 'CapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapAmb:\t0000000000000000\n',
        ...privilege,
    }
    const outcome = await runRuntime({ privilege: ops }).then(() => 'started', (error: Error) => error.message)
    return { outcome, dir, stateDir, runtimePort, browserRequests: () => browserRequests }
}

describe('Runtime root start', () => {
    it.each<[string, Partial<PrivilegeOps>, RegExp]>([
        ['setuid fails', { setuid: () => { throw new Error('EPERM, Operation not permitted') } }, /EPERM/],
        ['a capability survives', { readStatus: async () => 'CapPrm:\t00000000000000c0\nCapEff:\t0000000000000000\nCapAmb:\t0000000000000000\n' }, /still holds capabilities/],
    ])('stops before state, browsers or the task API when %s, and releases the sockets it bound', async (_label, privilege, message) => {
        const started = await rootStart(privilege)
        expect(started.outcome).toMatch(message)
        expect(await readdir(started.stateDir)).toEqual([])
        expect(started.browserRequests()).toBe(0)
        expect(await reachable({ port: started.runtimePort })).toBe(false)
        expect(await reachable({ path: join(started.dir, 'broker.sock') })).toBe(false)
        expect(await reachable({ path: join(started.dir, 'admin.sock') })).toBe(false)
    })
})
