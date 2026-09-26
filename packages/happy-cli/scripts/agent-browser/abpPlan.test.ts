import { generateKeyPairSync } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseRuntimeConfig } from '../../src/browserRuntime/runtimeConfig'
import {
    DEFAULT_RUNTIME_PORT, PATHS, browserCreateArgs, chromiumSeccompProfile, daemonEnv, egressRules, egressRulesFile, fenceRule, firewallRules,
    firewallRulesFile, mergeInstallOptions, networkCreateArgs, permissionTable, runtimeConfig, runtimeCreateArgs, stackLayout, sudoersDropIn,
    systemdUnits, tmpfilesConf,
} from './lib/abpPlan.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pem = (type: 'ed25519' | 'rsa' = 'ed25519') => (type === 'rsa'
    ? generateKeyPairSync('rsa', { modulusLength: 1024 })
    : generateKeyPairSync('ed25519')).publicKey.export({ type: 'spki', format: 'pem' }).toString()
const SITES = [{ origin: 'https://shop.example', actions: [{ match: { role: 'button', name: 'Buy' }, risk: 'requires-approval' }] }]
const base = () => mergeInstallOptions(undefined, {
    machineId: 'machine-1', workspaceId: 'ws-1',
    profiles: [{ profileId: 'main', principalId: 'user-1' }],
    issuers: [{ kid: 'k1', publicKeyPem: pem() }],
    sites: SITES,
})

describe('install options', () => {
    it('defaults the Runtime API to loopback port 38700 and keeps identity from flags', () => {
        const options = base()
        expect(options).toMatchObject({ schemaVersion: 1, machineId: 'machine-1', workspaceId: 'ws-1', runtimePort: DEFAULT_RUNTIME_PORT, maxAgentWindows: 4, retentionDays: 7, agentProfileId: 'main', happyPrefix: '/opt/abp/happy' })
        expect(DEFAULT_RUNTIME_PORT).toBe(38700)
    })

    it('reuses the saved options on a re-run and overrides only what the flags give', () => {
        const saved = base()
        const merged = mergeInstallOptions(saved, { profiles: [{ profileId: 'main', principalId: 'user-2' }] })
        expect(merged.machineId).toBe('machine-1')
        expect(merged.profiles).toEqual([{ profileId: 'main', principalId: 'user-2' }])
        expect(merged.trustedIssuers).toEqual(saved.trustedIssuers)
    })

    it('refuses what the Runtime or the stack could not use', () => {
        const bad: Array<[string, Record<string, unknown>]> = [
            ['no profile', { profiles: [] }],
            ['docker-unsafe profile id', { profiles: [{ profileId: '../x', principalId: 'u' }] }],
            ['duplicate profile', { profiles: [{ profileId: 'a', principalId: 'u' }, { profileId: 'a', principalId: 'v' }] }],
            ['no issuer', { issuers: [] }],
            ['non-Ed25519 issuer', { issuers: [{ kid: 'k', publicKeyPem: pem('rsa') }] }],
            ['site with a path', { sites: [{ origin: 'https://shop.example/path' }] }],
            ['port 0', { runtimePort: 0 }],
            ['agent profile not configured', { agentProfileId: 'other' }],
            ['non-origin viewer origin', { viewerOrigins: ['tunnel.example'] }],
            ['egress domain wildcard', { egressDomains: ['*.anthropic.com'] }],
            ['relative Happy prefix', { happyPrefix: 'opt/happy' }],
            ['Happy prefix under a writable tree', { happyPrefix: '/tmp/happy' }],
            ['Happy prefix in a private home', { happyPrefix: '/home/agent/happy' }],
            // The installer replaces the whole prefix: it must be a directory of its own.
            ['shared prefix /usr/local', { happyPrefix: '/usr/local' }],
            ['shared prefix /opt', { happyPrefix: '/opt' }],
            ['shared prefix /usr', { happyPrefix: '/usr' }],
            ['Happy prefix with a trailing slash', { happyPrefix: '/opt/abp/happy/' }],
            ['Happy prefix with a doubled slash', { happyPrefix: '/opt//happy' }],
            ['public browser subnet pool', { browserSubnetPool: '8.8.0.0/20' }],
            ['browser subnet pool not a /20', { browserSubnetPool: '10.249.0.0/16' }],
            ['deny CIDR not a network', { denyCidrs: ['10.0.0.1/33'] }],
            // ipset hash:net refuses prefix 0, so abp-firewall apply-egress would fail on every start.
            ['deny CIDR of everything', { denyCidrs: ['0.0.0.0/0'] }],
            ['browser DNS not an IPv4 address', { browserDns: ['dns.example'] }],
            ['more than 16 profiles', { profiles: Array.from({ length: 17 }, (_, i) => ({ profileId: `p${i}`, principalId: 'u' })) }],
        ]
        for (const [name, override] of bad) {
            expect(() => mergeInstallOptions(base(), override), name).toThrow()
        }
        expect(() => mergeInstallOptions(undefined, { workspaceId: 'w', profiles: [{ profileId: 'a', principalId: 'u' }], issuers: [{ kid: 'k', publicKeyPem: pem() }] }), 'missing machineId').toThrow(/machineId/)
    })

    it('allows exactly one profile named main in release 1 (the Desktop requests profile main)', () => {
        expect(() => mergeInstallOptions(base(), { profiles: [{ profileId: 'ops', principalId: 'u' }] })).toThrow(/exactly one profile named main/)
        expect(() => mergeInstallOptions(base(), { profiles: [{ profileId: 'main', principalId: 'u1' }, { profileId: 'ops', principalId: 'u2' }] })).toThrow(/exactly one profile named main/)
        expect(mergeInstallOptions(base(), { profiles: [{ profileId: 'main', principalId: 'u9' }] }).profiles).toEqual([{ profileId: 'main', principalId: 'u9' }])
    })

    it('refuses a private key given as the issuer key and never echoes it', () => {
        const privatePem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
        let message = ''
        try { mergeInstallOptions(base(), { issuers: [{ kid: 'k', publicKeyPem: privatePem }] }) } catch (error) { message = (error as Error).message }
        expect(message).toMatch(/public key/)
        expect(message).not.toContain(privatePem.split('\n')[1])
    })

    it('stores only the canonical SPKI PEM of an issuer key', () => {
        const canonical = pem()
        const messy = `${canonical.replace(/\n/g, '\r\n')}\r\n\r\n`
        const options = mergeInstallOptions(base(), { issuers: [{ kid: 'k', publicKeyPem: messy }] })
        expect(options.trustedIssuers[0].publicKeyPem).toBe(canonical)
    })

    it('never quotes key material in an error', () => {
        const secretish = '-----BEGIN PUBLIC KEY-----\nnot-a-key-SENTINEL\n-----END PUBLIC KEY-----\n'
        expect(() => mergeInstallOptions(base(), { issuers: [{ kid: 'k', publicKeyPem: secretish }] })).toThrow(/^(?![\s\S]*SENTINEL)/)
    })
})

describe('runtime.json', () => {
    it('is a valid production Runtime config (S2 schema) with loopback-only port, token hash and broker group', () => {
        const config = runtimeConfig(base(), { sessionGid: 990, daemonTokenSha256: 'a'.repeat(64) })
        expect(config).toMatchObject({
            authMode: 'production', machineId: 'machine-1', workspaceId: 'ws-1', runtimeHost: '0.0.0.0', runtimePort: 38700,
            brokerSocketPath: '/run/abp/broker.sock', adminSocketPath: '/run/abp/admin.sock', brokerSocketGid: 990, daemonTokenSha256: 'a'.repeat(64),
            profiles: [{ profileId: 'main', principalId: 'user-1' }],
        })
        // Endpoints come from ABP_PROFILES (the stack), so the file carries identity only.
        expect(Object.keys(config.profiles[0]).sort()).toEqual(['principalId', 'profileId'])
        expect(() => parseRuntimeConfig(config)).not.toThrow()
    })

    it('adds viewer origins only when configured (field belongs to the viewer stream)', () => {
        expect(runtimeConfig(base(), { sessionGid: 1, daemonTokenSha256: 'b'.repeat(64) })).not.toHaveProperty('viewerOrigins')
        const withViewer = mergeInstallOptions(base(), { viewerOrigins: ['https://tunnel.example'] })
        expect(runtimeConfig(withViewer, { sessionGid: 1, daemonTokenSha256: 'b'.repeat(64) }).viewerOrigins).toEqual(['https://tunnel.example'])
    })

    it('refuses a missing or malformed daemon token hash', () => {
        expect(() => runtimeConfig(base(), { sessionGid: 1, daemonTokenSha256: 'xyz' })).toThrow()
    })
})

describe('permissions', () => {
    const table = permissionTable()
    const entry = (path: string) => table.find((row: { path: string }) => row.path === path)

    it('matches the installed layout the Runtime, broker and sandbox preflight expect', () => {
        expect(entry('/etc/abp/runtime.json')).toMatchObject({ owner: 'root', group: 'root', mode: '0600' })
        expect(entry('/etc/abp/egress.rules4')).toMatchObject({ owner: 'root', group: 'root', mode: '0644' })
        expect(entry('/var/lib/abp/happy-package.sha256')).toMatchObject({ owner: 'root', group: 'root', mode: '0600' })
        expect(entry('/etc/abp')).toMatchObject({ owner: 'root', group: 'root', mode: '0700' })
        expect(entry('/run/abp')).toMatchObject({ owner: 'root', group: 'abp-session', mode: '0750' })
        expect(entry('/run/abp-mcp')).toMatchObject({ owner: 'agent', group: 'agent-sbx', mode: '0710' })
        expect(entry('/var/lib/abp')).toMatchObject({ owner: 'root', group: 'abp-session', mode: '0710' })
        expect(entry('/var/lib/abp/daemon-token')).toMatchObject({ owner: 'agent', group: 'agent', mode: '0400' })
        expect(entry('/home/agent')).toMatchObject({ owner: 'agent', mode: '0700' })
        expect(entry('/home/agent-sbx')).toMatchObject({ owner: 'agent-sbx', mode: '0700' })
        expect(entry('/work')).toMatchObject({ owner: 'agent', group: 'abp-work', mode: '2770' })
        expect(entry('/usr/local/libexec/abp/claude-sbx-launch')).toMatchObject({ owner: 'root', group: 'root', mode: '0755' })
        expect(entry('/usr/local/libexec/abp/abp-firewall-read')).toMatchObject({ owner: 'root', group: 'abp-session', mode: '4750' })
        expect(entry('/etc/aplus/sandbox-policy.json')).toMatchObject({ owner: 'root', mode: '0644' })
        expect(entry('/etc/sudoers.d/abp-agent-sbx')).toMatchObject({ owner: 'root', group: 'root', mode: '0440' })
    })

    it('gives each secret to exactly the one identity that reads it, never world or agent-sbx', () => {
        const secrets = table.filter((row: { secret?: boolean }) => row.secret)
        expect(secrets.map((row: { path: string }) => row.path).sort()).toEqual([
            '/var/lib/abp/daemon-token', '/var/lib/abp/secrets/browser/vnc-password', '/var/lib/abp/secrets/runtime/vnc-password',
        ])
        for (const row of secrets) {
            expect(Number.parseInt(row.mode, 8) & 0o007, row.path).toBe(0)
            expect([row.owner, row.group]).not.toContain('agent-sbx')
        }
        expect(entry('/var/lib/abp/secrets/runtime/vnc-password')).toMatchObject({ owner: 'abp-runtime', group: 'root', mode: '0440' })
        expect(entry('/var/lib/abp/secrets/browser/vnc-password')).toMatchObject({ owner: 'abp-browser', mode: '0400' })
    })
})

describe('firewall owner rules', () => {
    it('lets agent-sbx reach only the loopback proxy and abp-proxy only public 443, in S1 preflight order', () => {
        const v4 = firewallRules(4, 1001, 1002)
        expect(v4[0]).toBe('-A OUTPUT -d 127.0.0.1/32 -p tcp -m owner --uid-owner 1001 -m tcp --dport 3128 -j ACCEPT')
        expect(v4[1]).toBe('-A OUTPUT -m owner --uid-owner 1001 -j REJECT')
        expect(v4).toContain('-A OUTPUT -d 10.0.0.0/8 -m owner --uid-owner 1002 -j REJECT')
        expect(v4.at(-2)).toBe('-A OUTPUT -p tcp -m owner --uid-owner 1002 -m tcp --dport 443 -j ACCEPT')
        expect(v4.at(-1)).toBe('-A OUTPUT -m owner --uid-owner 1002 -j REJECT')
        const v6 = firewallRules(6, 1001, 1002)
        expect(v6[0]).toBe('-A OUTPUT -m owner --uid-owner 1001 -j REJECT')
        expect(v6.at(-2)).toBe('-A OUTPUT -d 2000::/3 -p tcp -m owner --uid-owner 1002 -m tcp --dport 443 -j ACCEPT')
    })

    // Drift guard: once the sandbox stream (S1) is merged, the installed rules must equal what its preflight compares.
    const s1 = join(here, '../../src/sandbox/sandboxPreflight.ts')
    it.skipIf(!existsSync(s1))('equals the sandbox preflight rules exactly', async () => {
        const module = await import(/* @vite-ignore */ s1) as { firewallRules: (family: 4 | 6, sbx: number, proxy: number) => string[] }
        for (const family of [4, 6] as const) expect(firewallRules(family, 2001, 2002)).toEqual(module.firewallRules(family, 2001, 2002))
    })
})

describe('system files', () => {
    it('sudoers allows agent exactly the fixed launcher as agent-sbx with a reset environment', () => {
        expect(sudoersDropIn()).toBe([
            '# Managed by abp-install. agent may start only the fixed Claude sandbox launcher as agent-sbx.',
            'Defaults:agent env_reset,!use_pty',
            'agent ALL=(agent-sbx) NOPASSWD: /usr/local/libexec/abp/claude-sbx-launch 0',
            '',
        ].join('\n'))
    })

    it('recreates the socket directories at boot with their installed modes', () => {
        expect(tmpfilesConf()).toContain('d /run/abp 0750 root abp-session -')
        expect(tmpfilesConf()).toContain('d /run/abp-mcp 0710 agent agent-sbx -')
    })

    it('orders firewall before proxy, stack and daemon, and supervises the stack and daemon', () => {
        const units = systemdUnits({ happyPrefix: '/opt/abp/happy' })
        expect(Object.keys(units).sort()).toEqual(['abp-egress-proxy.service', 'abp-egress.service', 'abp-firewall.service', 'abp-happy-daemon.service', 'abp-stack.service'])
        expect(units['abp-firewall.service']).toMatch(/Type=oneshot[\s\S]*RemainAfterExit=yes/)
        expect(units['abp-firewall.service']).toMatch(/Before=.*abp-egress-proxy\.service.*abp-stack\.service.*abp-happy-daemon\.service/)
        expect(units['abp-stack.service']).toMatch(/Restart=always/)
        expect(units['abp-stack.service']).toMatch(/Requires=docker\.service abp-firewall\.service abp-egress\.service/)
        // -F: node itself holds the lock and receives SIGTERM, so it can fence, drain and stop the containers.
        expect(units['abp-stack.service']).toContain('ExecStart=/usr/bin/flock -n -F /run/abp-stack.lock /usr/local/sbin/abp-stack run')
        expect(units['abp-egress.service']).toMatch(/After=docker\.service/)
        expect(units['abp-egress.service']).toMatch(/PartOf=docker\.service/)
        expect(units['abp-egress.service']).toMatch(/Before=abp-stack\.service/)
        expect(units['abp-egress.service']).toContain('ExecStart=/usr/local/libexec/abp/abp-firewall apply-egress')
        const daemon = units['abp-happy-daemon.service']
        expect(daemon).toContain('User=agent')
        expect(daemon).toContain('ExecStart=/opt/abp/happy/bin/happy daemon start-sync')
        expect(daemon).toContain('ExecStop=/opt/abp/happy/bin/happy daemon stop')
        expect(daemon).toContain('EnvironmentFile=/etc/abp/happy-daemon.env')
        expect(daemon).toMatch(/Requires=abp-firewall\.service/)
        // Sessions outlive a daemon restart (key rotation, upgrade) as they do outside systemd.
        expect(daemon).toContain('KillMode=process')
        // sudo must work for the sandbox launcher.
        expect(daemon).not.toContain('NoNewPrivileges=yes')
        const proxy = units['abp-egress-proxy.service']
        expect(proxy).toContain('User=abp-proxy')
        expect(proxy).toContain('ExecStart=/usr/bin/node /opt/abp/happy/lib/node_modules/@buzzni/happy-cli/dist/sandbox/egressProxyMain.mjs')
        expect(proxy).toContain('NoNewPrivileges=yes')
    })

    it('points the daemon at the broker socket, token file and loopback Runtime without any secret', () => {
        const env = daemonEnv(base())
        expect(env).toContain('HAPPY_BROWSER_TASK_RUNTIME_URL=http://127.0.0.1:38700')
        expect(env).toContain('HAPPY_BROWSER_TASK_BROKER_SOCKET=/run/abp/broker.sock')
        expect(env).toContain('HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE=/var/lib/abp/daemon-token')
        expect(env).toContain('HAPPY_BROWSER_TASK_PROFILE_ID=main')
        expect(env).not.toMatch(/SECRET|GRANT_FILE|TOKEN=/)
    })

    it('gives every daemon session an enabled sandbox config bounded to /work (mandatory machine)', () => {
        const line = daemonEnv(base()).split('\n').find((entry: string) => entry.startsWith('HAPPY_PROJECT_SANDBOX_CONFIG='))!
        const value = line.slice('HAPPY_PROJECT_SANDBOX_CONFIG='.length)
        expect(value.startsWith("'") && value.endsWith("'")).toBe(true)
        expect(JSON.parse(value.slice(1, -1))).toMatchObject({ enabled: true, workspaceRoot: '/work', sessionIsolation: 'workspace', extraWritePaths: [] })
    })
})

describe('browser networks and egress firewall', () => {
    it('lets a test-only allow list through before the private deny, and nothing else', () => {
        const plain = egressRules(stackLayout(mergeInstallOptions(base(), {})), mergeInstallOptions(base(), {}))[4].chains['ABP-EGRESS']
        expect(plain.some((rule: string) => rule.includes('-d 10.20.30.40/32 -j RETURN'))).toBe(false)
        const withTest = mergeInstallOptions(base(), { testAllowCidrs: ['10.20.30.40/32'] })
        const chain = egressRules(stackLayout(withTest), withTest)[4].chains['ABP-EGRESS']
        const allow = chain.findIndex((rule: string) => rule.endsWith('-d 10.20.30.40/32 -j RETURN'))
        const deny = chain.findIndex((rule: string) => rule.includes('--match-set abp-deny4 dst -j REJECT'))
        expect(allow).toBeGreaterThanOrEqual(0)
        expect(allow).toBeLessThan(deny)
        // The fixture's replies to the browser come back through the same bridge chain.
        const browser = stackLayout(withTest).browsers[0].browserIp
        expect(chain).toContain(`-s 10.20.30.40/32 -d ${browser}/32 -m conntrack --ctstate ESTABLISHED --ctdir REPLY -j RETURN`)
        expect(() => mergeInstallOptions(base(), { testAllowCidrs: ['0.0.0.0/0'] })).toThrow(/testAllowCidrs/)
    })

    // The generators support several profiles; the installer allows only main in release 1, so build the options directly.
    const install = {
        ...mergeInstallOptions(base(), { denyCidrs: ['203.0.114.0/24'], browserDns: ['10.0.0.2'] }),
        profiles: [{ profileId: 'main', principalId: 'u1' }, { profileId: 'ops', principalId: 'u2' }],
    }
    const layout = stackLayout(install)

    it('gives every profile a fixed bridge name and fixed addresses from the pool', () => {
        expect(layout.browsers.map((b: any) => [b.bridge, b.subnet, b.gateway, b.browserIp, b.runtimeIp])).toEqual([
            [expect.stringMatching(/^br-abp-[0-9a-f]{8}$/), '10.249.240.0/24', '10.249.240.1', '10.249.240.2', '10.249.240.3'],
            [expect.stringMatching(/^br-abp-[0-9a-f]{8}$/), '10.249.241.0/24', '10.249.241.1', '10.249.241.2', '10.249.241.3'],
        ])
        expect(layout.browsers[0].bridge).toHaveLength(15)
        expect(stackLayout(install).browsers[0].bridge).toBe(layout.browsers[0].bridge)
        expect(networkCreateArgs(layout.browsers[0])).toEqual(['network', 'create', '--driver=bridge', '--label=ai.saycode.abp=stack',
            '--subnet=10.249.240.0/24', '--gateway=10.249.240.1', `--opt=com.docker.network.bridge.name=${layout.browsers[0].bridge}`, 'abp-net-main'])
        const image = 'sha256:' + '2'.repeat(64)
        expect(browserCreateArgs(layout, layout.browsers[1], image)).toContain('--ip=10.249.241.2')
        expect(runtimeCreateArgs(layout, 'sha256:' + '1'.repeat(64))).toContain('--ip=10.249.240.3')
        expect(layout.runtime.attach).toEqual([{ network: 'abp-net-ops', ip: '10.249.241.3' }])
    })

    it('denies browsers private, special, metadata and deployment ranges but lets the Runtime reach them and DNS through', () => {
        const rules = egressRules(layout, install)
        const deny = rules[4].sets['abp-deny4']
        for (const cidr of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', '127.0.0.0/8', '224.0.0.0/3', '203.0.114.0/24']) expect(deny).toContain(cidr)
        expect(rules[4].jumps).toEqual([['DOCKER-USER', '-i br-abp+ -j ABP-EGRESS'], ['INPUT', '-i br-abp+ -j ABP-INPUT']])
        const chain = rules[4].chains['ABP-EGRESS']
        const at = (rule: string) => chain.indexOf(rule)
        const main = layout.browsers[0]
        expect(at(`-s ${main.runtimeIp}/32 -d ${main.browserIp}/32 -j RETURN`)).toBeGreaterThanOrEqual(0)
        const reply = at(`-s ${main.browserIp}/32 -d ${main.runtimeIp}/32 -m conntrack --ctstate ESTABLISHED --ctdir REPLY -j RETURN`)
        const dns = at(`-s ${main.browserIp}/32 -d 10.0.0.2/32 -p udp -m udp --dport 53 -j RETURN`)
        const denied = at(`-s ${main.browserIp}/32 -m set --match-set abp-deny4 dst -j REJECT`)
        const allowed = at(`-s ${main.browserIp}/32 -j RETURN`)
        expect(reply).toBeGreaterThanOrEqual(0)
        expect(dns).toBeGreaterThan(reply)
        expect(chain).toContain(`-s ${main.browserIp}/32 -d 10.0.0.2/32 -p tcp -m tcp --dport 53 -j RETURN`)
        expect(denied).toBeGreaterThan(dns)
        expect(allowed).toBeGreaterThan(denied)
        // The Runtime, and anything else on a browser bridge, may not leave it.
        expect(chain.at(-1)).toBe('-j REJECT')
        expect(chain).not.toContain(`-s ${main.runtimeIp}/32 -j RETURN`)
        expect(rules[4].chains['ABP-INPUT']).toEqual(['-m conntrack --ctstate RELATED,ESTABLISHED -j RETURN', '-j REJECT'])
    })

    it('writes a /32 deny entry as the bare host, the form ipset save reports (check-egress compares them)', () => {
        const hosts = stackLayout({ ...install, denyCidrs: ['203.0.114.7/32'] })
        const deny = egressRules(hosts, { ...install, denyCidrs: ['203.0.114.7/32'] })[4].sets['abp-deny4']
        expect(deny).toContain('203.0.114.7')
        expect(deny).not.toContain('203.0.114.7/32')
    })

    it('rejects all IPv6 from browser bridges (they have no IPv6 addresses to use)', () => {
        const rules = egressRules(layout, install)
        expect(rules[6].jumps).toEqual([['FORWARD', '-i br-abp+ -j ABP-EGRESS'], ['INPUT', '-i br-abp+ -j ABP-INPUT']])
        expect(rules[6].chains).toEqual({ 'ABP-EGRESS': ['-j REJECT'], 'ABP-INPUT': ['-j REJECT'] })
    })

    it('writes line files abp-firewall applies (sets, chains, jumps)', () => {
        const text = egressRulesFile(egressRules(layout, install)[4])
        expect(text).toMatch(/^set abp-deny4 10\.0\.0\.0\/8$/m)
        expect(text).toMatch(/^chain ABP-EGRESS -j REJECT$/m)
        expect(text).toMatch(/^jump DOCKER-USER -i br-abp\+ -j ABP-EGRESS$/m)
    })

    it('adds the admission fence jump right after the S1 owner rules, and a fence rule for the Runtime port', () => {
        const lines = firewallRulesFile(4, 1001, 1002).trim().split('\n')
        expect(lines.slice(0, -1)).toEqual(firewallRules(4, 1001, 1002))
        expect(lines.at(-1)).toBe('-A OUTPUT -j ABP-FENCE')
        expect(fenceRule(38700)).toEqual(['-p', 'tcp', '-m', 'tcp', '--dport', '38700', '-j', 'REJECT', '--reject-with', 'tcp-reset'])
    })
})

describe('Chromium seccomp profile', () => {
    const baseProfile = JSON.parse(readFileSync(join(here, 'seccomp/moby-default.json'), 'utf8'))

    it('is Docker\'s default profile plus only the namespace calls the Chromium sandbox needs, with mount/UTS/IPC/cgroup namespaces still denied', () => {
        const profile = chromiumSeccompProfile(baseProfile)
        expect(profile.defaultAction).toBe(baseProfile.defaultAction)
        expect(profile.syscalls.slice(0, baseProfile.syscalls.length)).toEqual(baseProfile.syscalls)
        const added = profile.syscalls.slice(baseProfile.syscalls.length)
        // CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC must be clear; USER/PID/NET may be set.
        const forbidden = 0x00020000 | 0x02000000 | 0x04000000 | 0x08000000
        expect(added).toEqual([
            { names: ['chroot'], action: 'SCMP_ACT_ALLOW', comment: expect.any(String) },
            { names: ['clone'], action: 'SCMP_ACT_ALLOW', args: [{ index: 0, value: forbidden, valueTwo: 0, op: 'SCMP_CMP_MASKED_EQ' }], excludes: { arches: ['s390', 's390x'] }, comment: expect.any(String) },
            { names: ['clone'], action: 'SCMP_ACT_ALLOW', args: [{ index: 1, value: forbidden, valueTwo: 0, op: 'SCMP_CMP_MASKED_EQ' }], includes: { arches: ['s390', 's390x'] }, comment: expect.any(String) },
            { names: ['unshare'], action: 'SCMP_ACT_ALLOW', args: [{ index: 0, value: forbidden, valueTwo: 0, op: 'SCMP_CMP_MASKED_EQ' }], comment: expect.any(String) },
        ])
        expect(JSON.stringify(added)).not.toContain('setns')
    })

    it('refuses a base that is not a default-deny profile', () => {
        expect(() => chromiumSeccompProfile({ ...baseProfile, defaultAction: 'SCMP_ACT_ALLOW' })).toThrow()
    })
})

describe('stack containers', () => {
    const layout = stackLayout({ ...base(), profiles: [{ profileId: 'main', principalId: 'u1' }, { profileId: 'ops', principalId: 'u2' }] })
    const IMAGE_R = 'sha256:' + '1'.repeat(64)
    const IMAGE_B = 'sha256:' + '2'.repeat(64)

    it('gives each profile its own network shared only with the Runtime', () => {
        expect(layout.networks).toEqual(['abp-net-main', 'abp-net-ops'])
        const main = browserCreateArgs(layout, layout.browsers[0], IMAGE_B)
        expect(main).toContain('--network=abp-net-main')
        expect(main.join(' ')).not.toContain('abp-net-ops')
        expect(layout.runtime.network).toBe('abp-net-main')
    })

    it('publishes only the Runtime API on 127.0.0.1:38700 and runs it with the S2 production privileges', () => {
        const args = runtimeCreateArgs(layout, IMAGE_R)
        expect(args.filter((arg: string) => arg.startsWith('--publish'))).toEqual(['--publish=127.0.0.1:38700:38700'])
        for (const flag of ['--user=0:0', '--cap-drop=ALL', '--cap-add=SETUID', '--cap-add=SETGID', '--security-opt=no-new-privileges', '--read-only', '--restart=no']) expect(args).toContain(flag)
        expect(args).toContain('--mount=type=bind,source=/etc/abp/runtime.json,target=/etc/abp/runtime.json,readonly')
        expect(args).toContain('--mount=type=bind,source=/run/abp,target=/run/abp')
        expect(args).toContain('--mount=type=volume,source=abp-state,target=/var/lib/abp')
        expect(args).toContain('--env=ABP_VNC_PASSWORD_FILE=/run/secrets/abp/vnc-password')
        const profiles = JSON.parse(args.find((arg: string) => arg.startsWith('--env=ABP_PROFILES='))!.slice('--env=ABP_PROFILES='.length))
        expect(profiles).toEqual([
            { profileId: 'main', cdpHttpUrl: 'http://browser-main:9223', instanceUrl: 'http://browser-main:9224/instance', vncAddress: 'browser-main:5900' },
            { profileId: 'ops', cdpHttpUrl: 'http://browser-ops:9223', instanceUrl: 'http://browser-ops:9224/instance', vncAddress: 'browser-ops:5900' },
        ])
        expect(args.at(-1)).toBe(IMAGE_R)
    })

    it('runs browsers unpublished, sandboxed by Chromium under the shipped seccomp profile, with the profile volume kept', () => {
        const args = browserCreateArgs(layout, layout.browsers[1], IMAGE_B)
        expect(args.some((arg: string) => arg.startsWith('--publish') || arg === '-p')).toBe(false)
        for (const flag of ['--cap-drop=ALL', '--security-opt=no-new-privileges', `--security-opt=seccomp=${PATHS.seccompProfile}`, '--read-only', '--user=10871:10871']) expect(args).toContain(flag)
        expect(args).toContain('--mount=type=volume,source=abp-profile-ops,target=/home/browser/profile')
        expect(args).toContain('--network-alias=browser-ops')
        expect(args).toContain('--env=ABP_CDP_HOST=browser-ops:9223')
        expect(args.join(' ')).not.toMatch(/no-sandbox|seccomp=unconfined|--privileged|ABP_VNC_PASSWORD=/)
        expect(args.at(-1)).toBe(IMAGE_B)
    })

    it('refuses an image reference that is not a content digest', () => {
        expect(() => runtimeCreateArgs(layout, 'abp-runtime:latest')).toThrow()
        expect(() => browserCreateArgs(layout, layout.browsers[0], 'abp-browser:latest')).toThrow()
    })
})
