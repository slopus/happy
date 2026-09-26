import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { main as planMain, parseOptionFlags } from './abp-plan.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SECRET_SENTINEL = 'SENTINEL-not-a-real-secret-0123456789'
let dir: string
let pemFile: string
let sitesFile: string

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'abp-install-test-'))
    pemFile = join(dir, 'issuer.pem')
    sitesFile = join(dir, 'sites.json')
    writeFileSync(pemFile, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString())
    writeFileSync(sitesFile, JSON.stringify([{ origin: 'https://shop.example' }]))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const bash = (script: string, args: string[]) => spawnSync('bash', [join(here, script), ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, ABP_NODE: process.execPath, ABP_DRY_RUN_SECRET: SECRET_SENTINEL },
})

describe('abp-plan CLI', () => {
    it('parses install flags, reading issuer keys and the site policy from files', () => {
        const flags = parseOptionFlags(['--profile', 'main=user-1', '--profile', 'ops=user-2', '--issuer', `k1=${pemFile}`, '--sites', sitesFile, '--runtime-port', '38701', '--happy-prefix', '/opt/happy'])
        expect(flags.profiles).toEqual([{ profileId: 'main', principalId: 'user-1' }, { profileId: 'ops', principalId: 'user-2' }])
        expect(flags.issuers[0].publicKeyPem).toContain('BEGIN PUBLIC KEY')
        expect(flags).toMatchObject({ runtimePort: 38701, happyPrefix: '/opt/happy', sites: [{ origin: 'https://shop.example' }] })
        expect(() => parseOptionFlags(['--profile', 'main'])).toThrow(/<name>=<value>/)
        expect(() => parseOptionFlags(['--issuer', 'k1=/nonexistent/key.pem'])).toThrow(/unreadable/)
        expect(() => parseOptionFlags(['--bogus', 'x'])).toThrow(/unknown option/)
    })

    it('keeps the machine id "auto" until the agent has logged in to Happy', () => {
        let out = ''
        planMain(['install-options', '--saved', join(dir, 'missing.json'), '--workspace-id', 'w', '--profile', 'main=u', '--issuer', `k=${pemFile}`], (text: string) => { out += text })
        expect(JSON.parse(out).machineId).toBe('auto')
        const saved = join(dir, 'install.json')
        writeFileSync(saved, out)
        let resolved = ''
        planMain(['resolve-machine-id', '--install', saved, '--settings', join(dir, 'no-settings.json')], (text: string) => { resolved += text })
        expect(resolved).toBe('')
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ machineId: 'machine-from-happy' }))
        planMain(['resolve-machine-id', '--install', saved, '--settings', join(dir, 'settings.json')], (text: string) => { resolved += text })
        expect(resolved).toBe('machine-from-happy\n')
    })
})

describe('Happy package digest (restart the daemon and proxy when the installed code changes)', () => {
    const digest = (dir: string) => { let out = ''; planMain(['package-digest', '--dir', dir], (text: string) => { out += text }); return out.trim() }

    it('changes with file content, added files, exec bits and symlink targets, not with timestamps', () => {
        const root = mkdtempSync(join(tmpdir(), 'abp-pkg-'))
        mkdirSync(join(root, 'dist', 'sandbox'), { recursive: true })
        writeFileSync(join(root, 'package.json'), '{"version":"1.0.0"}')
        writeFileSync(join(root, 'dist', 'sandbox', 'egressProxyMain.mjs'), 'v1')
        symlinkSync('dist/sandbox/egressProxyMain.mjs', join(root, 'entry'))
        const first = digest(root)
        expect(first).toMatch(/^[0-9a-f]{64}$/)
        utimesSync(join(root, 'package.json'), new Date(0), new Date(0))
        expect(digest(root)).toBe(first)
        writeFileSync(join(root, 'dist', 'sandbox', 'egressProxyMain.mjs'), 'v2')
        const second = digest(root)
        expect(second).not.toBe(first)
        chmodSync(join(root, 'package.json'), 0o755)
        const third = digest(root)
        expect(third).not.toBe(second)
        writeFileSync(join(root, 'dist', 'new.mjs'), '')
        const fourth = digest(root)
        expect(fourth).not.toBe(third)
        rmSync(join(root, 'entry'))
        symlinkSync('package.json', join(root, 'entry'))
        expect(digest(root)).not.toBe(fourth)
        rmSync(root, { recursive: true, force: true })
    })

    it('restarts a service when one of its inputs changed, otherwise only starts it', () => {
        const decide = (changedPaths: string) => spawnSync('bash', ['-c', `set -euo pipefail; source "$1"; DRY_RUN=1; CHANGED=" ${changedPaths} "
            restart_or_start abp-happy-daemon.service /etc/abp/happy-daemon.env /var/lib/abp/happy-package.sha256
            restart_or_start abp-egress-proxy.service /etc/systemd/system/abp-egress-proxy.service /var/lib/abp/happy-package.sha256`, 'test', join(here, 'abp-install')], { encoding: 'utf8' }).stdout
        expect(decide('/var/lib/abp/happy-package.sha256')).toBe([
            '== restarting abp-happy-daemon.service (changed: /var/lib/abp/happy-package.sha256)',
            '+ systemctl restart abp-happy-daemon.service',
            '== restarting abp-egress-proxy.service (changed: /var/lib/abp/happy-package.sha256)',
            '+ systemctl restart abp-egress-proxy.service', ''].join('\n'))
        expect(decide('')).toBe(['+ systemctl start abp-happy-daemon.service', '+ systemctl start abp-egress-proxy.service', ''].join('\n'))
    })
})

describe('abp-install --dry-run', () => {
    const run = () => bash('abp-install', ['--dry-run', 'install', '--machine-id', 'machine-1', '--workspace-id', 'ws-1', '--profile', 'main=user-1',
        '--issuer', `k1=${pemFile}`, '--sites', sitesFile, '--images', join(dir, 'images')])

    it('prints every action without needing root and exits 0', () => {
        const result = run()
        expect(result.stderr).not.toMatch(/abp-install: (?!warning)/)
        expect(result.status).toBe(0)
        for (const line of result.stdout.split('\n').filter(Boolean)) expect(line).toMatch(/^(\+ |== |    \| )/)
    })

    it('creates the accounts with the fixed container ids and the exact group memberships', () => {
        const out = run().stdout
        expect(out).toMatch(/\+ groupadd --system --gid 10870 abp-runtime/)
        expect(out).toMatch(/\+ useradd --system --uid 10870 --gid 10870 .* abp-runtime/)
        expect(out).toMatch(/\+ useradd --system --uid 10871 --gid 10871 .* abp-browser/)
        expect(out).toMatch(/\+ useradd --system .*--shell \/usr\/sbin\/nologin .*abp-proxy/)
        expect(out).toMatch(/\+ useradd --create-home --home-dir \/home\/agent-sbx .* agent-sbx/)
        expect(out).toMatch(/\+ useradd --create-home --home-dir \/home\/agent .*--shell \/bin\/bash .* agent/)
        expect(out).toContain('+ usermod -a -G abp-session,abp-work,agent-sbx agent')
        expect(out).toContain('+ usermod -G abp-work agent-sbx')
    })

    it('installs the S1 sandbox pieces with the documented modes and validates sudoers', () => {
        const out = run().stdout
        expect(out).toMatch(/\+ install -o root -g root -m 0755 \S+claude-sbx-launch \/usr\/local\/libexec\/abp\/claude-sbx-launch/)
        expect(out).toMatch(/\+ cc .*abp-firewall-read\.c/)
        expect(out).toMatch(/\+ install -o root -g abp-session -m 4750 \S+ \/usr\/local\/libexec\/abp\/abp-firewall-read/)
        expect(out).toMatch(/\+ visudo -cf \S+/)
        expect(out).toContain('+ write /etc/sudoers.d/abp-agent-sbx (root:root 0440')
        expect(out).toContain('    | agent ALL=(agent-sbx) NOPASSWD: /usr/local/libexec/abp/claude-sbx-launch 0')
        expect(out).toContain('+ write /etc/aplus/sandbox-policy.json (root:root 0644')
        expect(out).toContain('    |   "mode": "mandatory"')
    })

    it('writes the production runtime.json, firewall rules, units and daemon environment', () => {
        const out = run().stdout
        expect(out).toContain('+ write /etc/abp/runtime.json (root:root 0600')
        expect(out).toContain('    |   "authMode": "production",')
        expect(out).toContain('    |   "runtimePort": 38700,')
        expect(out).toContain('+ write /etc/abp/firewall.rules4 (root:root 0644')
        expect(out).toMatch(/ {4}\| -A OUTPUT -d 127\.0\.0\.1\/32 -p tcp -m owner --uid-owner \d+ -m tcp --dport 3128 -j ACCEPT/)
        expect(out).toContain('+ write /etc/systemd/system/abp-stack.service (root:root 0644')
        expect(out).toContain('+ write /etc/abp/happy-daemon.env (root:root 0644')
        expect(out).toContain('+ systemctl enable abp-firewall.service abp-egress.service abp-egress-proxy.service abp-stack.service abp-happy-daemon.service')
        expect(out).toContain('+ write /etc/abp/egress.rules4 (root:root 0644')
        expect(out).toMatch(/ {4}\| jump DOCKER-USER -i br-abp\+ -j ABP-EGRESS/)
        // Re-applying the rules must not restart their dependents (Requires= propagates a restart to the
        // proxy, the daemon and the whole stack): reload runs ExecReload (apply) without that propagation.
        expect(out).toContain('+ systemctl reload-or-restart abp-firewall.service')
        expect(out).toContain('+ systemctl reload-or-restart abp-egress.service')
        expect(out).not.toMatch(/systemctl restart abp-(firewall|egress)\.service/)
        expect(out).toMatch(/\+ record the Happy package digest of \/opt\/abp\/happy\/lib\/node_modules\/@buzzni\/happy-cli in \/var\/lib\/abp\/happy-package\.sha256/)
        expect(out).toMatch(/\+ \S*node \S+abp-stack\.mjs load \S+images --set-initial/)
        expect(out).toContain('+ systemd-tmpfiles --create /etc/tmpfiles.d/abp.conf')
        expect(out).toContain('+ runuser -u agent -- install -d -g abp-work -m 2770 /work/agent-workspace')
        expect(out).toContain('+ runuser -u agent -- setfacl -P -d -m g:abp-work:rwX,m::rwx /work/agent-workspace')
        expect(out).toMatch(/\+ migrate \/home\/agent\/workspace -> \/work\/agent-workspace \(as agent\)/)
    })

    it('generates secrets only when missing and never prints them', () => {
        const result = run()
        expect(result.stdout).toContain('+ secret /var/lib/abp/daemon-token (agent:agent 0400) if missing')
        expect(result.stdout).toContain('+ secret /var/lib/abp/secrets/{runtime,browser}/vnc-password (same value; abp-runtime:root 0440, abp-browser:abp-browser 0400) if missing')
        expect(result.stdout + result.stderr).not.toContain(SECRET_SENTINEL)
    })

    it('refuses invalid options before any action', () => {
        const result = bash('abp-install', ['--dry-run', 'install', '--machine-id', 'm', '--workspace-id', 'w', '--profile', 'BAD=u', '--issuer', `k1=${pemFile}`])
        expect(result.status).not.toBe(0)
        expect(result.stderr).toMatch(/profileId/)
        expect(result.stdout).not.toMatch(/useradd/)
        const other = bash('abp-install', ['--dry-run', 'install', '--machine-id', 'm', '--workspace-id', 'w', '--profile', 'ops=u', '--issuer', `k1=${pemFile}`])
        expect(other.status).not.toBe(0)
        expect(other.stderr).toMatch(/exactly one profile named main/)
        expect(other.stdout).not.toMatch(/useradd/)
    })
})

/**
 * safe_path refuses paths below directories that others may write (e.g. /tmp, 1777), so its
 * fixtures must live below a directory whose whole ancestor chain passes the same rule: owned by
 * root or this user, not group/other-writable, no symlinks. The candidate must also be writable
 * (proved by creating and removing a directory: a sandboxed or read-only home can pass the ownership
 * rule and still refuse writes). Candidates are tried in a fixed order; the first one that qualifies
 * is used, and without one these suites are skipped.
 */
function trustedBase(): string | undefined {
    const uid = userInfo().uid
    const passes = (dir: string): boolean => {
        for (let current = dir; ; current = dirname(current)) {
            const stat = lstatSync(current)
            if (stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== uid) || (stat.mode & 0o022)) return false
            if (current === '/') return true
        }
    }
    const writable = (dir: string): boolean => {
        try {
            rmSync(mkdtempSync(join(dir, '.abp-probe-')), { recursive: true, force: true })
            return true
        } catch {
            return false
        }
    }
    for (const candidate of [tmpdir(), homedir(), join(here, '..', '..'), here, process.cwd()]) {
        try {
            const real = realpathSync(candidate)
            if (passes(real) && writable(real)) return real
        } catch { /* try the next one */ }
    }
    return undefined
}
const fixtureBase = trustedBase()

describe.skipIf(!fixtureBase)('abp-install internals (sourced; needs a directory with a trusted ancestor chain)', () => {
    /** Runs a snippet with abp-install's functions loaded (main does not run when sourced). */
    const sourced = (snippet: string) => spawnSync('bash', ['-c', `set -euo pipefail; source "$1"; DRY_RUN=0; ${snippet}`, 'test', join(here, 'abp-install')], {
        encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, ABP_NODE: process.execPath },
    })
    const me = spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim()
    const group = spawnSync('id', ['-gn'], { encoding: 'utf8' }).stdout.trim()

    it('never pipes into write_file (a pipeline runs it in a subshell and loses the change record)', () => {
        const source = readFileSync(join(here, 'abp-install'), 'utf8')
        expect(source.split('\n').filter((line) => /\|\s*write_file\b/.test(line) && !line.trim().startsWith('#'))).toEqual([])
    })

    it('records a changed file in the parent shell and not an unchanged one, so restarts follow real changes', () => {
        const root = mkdtempSync(join(fixtureBase!, '.abp-emit-'))
        chmodSync(root, 0o755)
        const target = join(root, 'config.json')
        const result = sourced(`
            emit() { printf '%s' "$4" > "$WORK/x"; write_file "$1" "$2" "$3" 0600 < "$WORK/x"; }
            WORK=$(mktemp -d)
            emit ${target} ${me} ${group} one; changed ${target} && echo first-changed
            CHANGED=" "; emit ${target} ${me} ${group} one; changed ${target} || echo second-unchanged
            CHANGED=" "; emit ${target} ${me} ${group} two; changed ${target} && echo third-changed`)
        expect(result.stderr).toBe('')
        expect(result.stdout.split('\n').filter(Boolean)).toEqual(['first-changed', 'second-unchanged', 'third-changed'])
        expect(readFileSync(target, 'utf8')).toBe('two')
        rmSync(root, { recursive: true, force: true })
    })

    it('refuses to write through a symlink, under a symlinked or group-writable directory', () => {
        const root = mkdtempSync(join(fixtureBase!, '.abp-path-'))
        chmodSync(root, 0o755)
        mkdirSync(join(root, 'real'), { mode: 0o755 })
        writeFileSync(join(root, 'elsewhere'), 'x')
        symlinkSync(join(root, 'elsewhere'), join(root, 'real', 'link'))
        symlinkSync(join(root, 'real'), join(root, 'linkdir'))
        mkdirSync(join(root, 'open'), { mode: 0o775 })
        chmodSync(join(root, 'open'), 0o775)
        expect(sourced(`safe_path ${join(root, 'real', 'ok')} file ${me} && echo fine`).stdout.trim()).toBe('fine')
        expect(sourced(`safe_path ${join(root, 'real', 'link')} file ${me}`).stderr).toMatch(/symbolic link/)
        expect(sourced(`safe_path ${join(root, 'linkdir', 'file')} file ${me}`).stderr).toMatch(/symbolic link/)
        expect(sourced(`safe_path ${join(root, 'open', 'file')} file ${me}`).stderr).toMatch(/writable by group or others/)
        expect(sourced(`safe_path ${join(root, 'real')} file ${me}`).stderr).toMatch(/not a regular file/)
        rmSync(root, { recursive: true, force: true })
    })
})

describe.skipIf(!fixtureBase)('abp-install agent workspace (Desktop chats live under /home/agent/workspace; the sandbox needs /work)', () => {
    /** migrate_workspace runs file operations as the agent user; here that user is the test user. */
    const migrate = (link: string, target: string) => spawnSync('bash', ['-c', `set -euo pipefail; source "$1"; DRY_RUN=0
        as_user() { shift; "$@"; }
        migrate_workspace "$2" "$3" "$(id -un)"`, 'test', join(here, 'abp-install'), link, target], { encoding: 'utf8' })
    const fresh = () => {
        const root = mkdtempSync(join(fixtureBase!, '.abp-ws-'))
        mkdirSync(join(root, 'work', 'agent-workspace'), { recursive: true })
        mkdirSync(join(root, 'home'))
        return { root, link: join(root, 'home', 'workspace'), target: join(root, 'work', 'agent-workspace') }
    }

    it('creates the symlink when there is no workspace yet, and leaves a correct one alone', () => {
        const { root, link, target } = fresh()
        expect(migrate(link, target).status).toBe(0)
        expect(realpathSync(link)).toBe(realpathSync(target))
        const again = migrate(link, target)
        expect(again.status).toBe(0)
        expect(again.stdout).toMatch(/already links to/)
        rmSync(root, { recursive: true, force: true })
    })

    it('moves an existing workspace (dotfiles included) into /work and replaces it with the symlink', () => {
        const { root, link, target } = fresh()
        mkdirSync(join(link, 'aplus-dev-studio-workspace', 'ctx', 'chats', 'c1'), { recursive: true })
        writeFileSync(join(link, 'aplus-dev-studio-workspace', 'ctx', 'chats', 'c1', 'notes.md'), 'kept')
        writeFileSync(join(link, '.hidden'), 'dot')
        const result = migrate(link, target)
        expect(result.stderr).toBe('')
        expect(result.status).toBe(0)
        expect(lstatSync(link).isSymbolicLink()).toBe(true)
        expect(readFileSync(join(target, 'aplus-dev-studio-workspace', 'ctx', 'chats', 'c1', 'notes.md'), 'utf8')).toBe('kept')
        expect(readFileSync(join(target, '.hidden'), 'utf8')).toBe('dot')
        rmSync(root, { recursive: true, force: true })
    })

    it('refuses to overwrite: a name present in both places, a symlink elsewhere, or a regular file', () => {
        const conflict = fresh()
        mkdirSync(conflict.link)
        writeFileSync(join(conflict.link, 'same'), 'old')
        writeFileSync(join(conflict.target, 'same'), 'new')
        const clash = migrate(conflict.link, conflict.target)
        expect(clash.status).not.toBe(0)
        expect(clash.stderr).toMatch(/already exists in/)
        expect(readFileSync(join(conflict.link, 'same'), 'utf8')).toBe('old')
        rmSync(conflict.root, { recursive: true, force: true })

        const elsewhere = fresh()
        symlinkSync(elsewhere.root, elsewhere.link)
        expect(migrate(elsewhere.link, elsewhere.target).stderr).toMatch(/is a symlink to .* not /)
        rmSync(elsewhere.root, { recursive: true, force: true })

        const file = fresh()
        writeFileSync(file.link, 'x')
        expect(migrate(file.link, file.target).stderr).toMatch(/is neither a directory nor a symlink/)
        rmSync(file.root, { recursive: true, force: true })
    })

    const acl = (setfacl: string, call: string) => spawnSync('bash', ['-c', `set -euo pipefail; source "$1"; DRY_RUN=0
        as_user() { echo "as $1:"; shift; "$@"; }
        setfacl() { ${setfacl}; }
        ${call}`, 'test', join(here, 'abp-install')], { encoding: 'utf8' })

    it('grants abp-work access by default ACLs (the daemon runs with umask 077) without walking the tree agent-sbx can write', () => {
        const ok = acl('echo "setfacl $*"', 'ensure_workspace_acls /work /work/agent-workspace')
        expect(ok.status).toBe(0)
        // /work: root (its parent is root's); the workspace: as its owner agent, single paths, -P skips a symlink argument.
        expect(ok.stdout.split('\n').filter(Boolean)).toEqual([
            'setfacl -P -d -m g:abp-work:rwX,m::rwx /work',
            'as agent:', 'setfacl -P -m g:abp-work:rwX /work/agent-workspace',
            'as agent:', 'setfacl -P -d -m g:abp-work:rwX,m::rwx /work/agent-workspace',
        ])
        expect(ok.stdout).not.toMatch(/-R/)
    })

    it('opens an existing legacy workspace recursively only while it is still inside the private home', () => {
        const legacy = acl('echo "setfacl $*"', 'grant_legacy_workspace /home/agent/workspace')
        expect(legacy.stdout.split('\n').filter(Boolean)).toEqual([
            'setfacl -R -P -m g:abp-work:rwX /home/agent/workspace',
            'setfacl -R -P -d -m g:abp-work:rwX,m::rwx /home/agent/workspace',
        ])
    })

    it('check creates nothing through a workspace link that does not point at /work yet', () => {
        const { root, link, target } = fresh()
        const result = spawnSync('bash', ['-c', `source "$1"; AGENT_WORKSPACE_LINK="$2"; AGENT_WORKSPACE="$3"
            as() { echo "unexpected: $*"; }
            if workspace_shared; then echo status=0; else echo status=1; fi`, 'test', join(here, 'abp-install'), link, target], { encoding: 'utf8' })
        expect(result.stdout.trim()).toBe('status=1')
        expect(() => lstatSync(link)).toThrow()
        rmSync(root, { recursive: true, force: true })
    })

    it('fails clearly when the filesystem has no POSIX ACLs', () => {
        const unsupported = acl('echo "setfacl: /work/agent-workspace: Operation not supported" >&2; return 1', 'ensure_workspace_acls /work /work/agent-workspace')
        expect(unsupported.status).not.toBe(0)
        expect(unsupported.stderr).toMatch(/does not support POSIX ACLs/)
    })
})

describe('abp-install Happy package replacement', () => {
    /** Root-only helpers stubbed; `npm` either fails (a full disk) or installs a complete package into --prefix. */
    /** `legacyDefault`: the path the installer treats as its own default prefix (unmarked installs are trusted only there). */
    const replace = (prefix: string, npmBody: string, legacyDefault = prefix) => spawnSync('bash', ['-c', `set -euo pipefail; source "$1"; DRY_RUN=0
        DEFAULT_HAPPY_PREFIX="$3"
        safe_path() { :; }; ensure_dir() { mkdir -p "$1"; }; chown() { :; }
        mv() { [ "$1" = -T ] && shift; command mv "$@"; }
        npm() { local p=""; while [ $# -gt 0 ]; do [ "$1" = --prefix ] && p=$2; shift; done; ${npmBody}; }
        replace_happy_package "$2" /tmp/pkg.tgz`, 'test', join(here, 'abp-install'), prefix, legacyDefault], { encoding: 'utf8' })
    /** A previously installed Happy package (no marker yet: installs made before the marker existed). */
    const live = () => {
        const root = mkdtempSync(join(tmpdir(), '.abp-happy-'))
        const prefix = join(root, 'happy')
        mkdirSync(join(prefix, 'bin'), { recursive: true })
        mkdirSync(join(prefix, 'lib', 'node_modules', '@buzzni', 'happy-cli'), { recursive: true })
        writeFileSync(join(prefix, 'bin', 'happy'), 'old')
        return { root, prefix }
    }
    const complete = 'mkdir -p "$p/bin" "$p/lib/node_modules/@buzzni/happy-cli/dist/sandbox"; echo new > "$p/bin/happy"; : > "$p/lib/node_modules/@buzzni/happy-cli/dist/sandbox/egressProxyMain.mjs"'

    it('leaves the running package untouched when npm fails part-way (a full disk)', () => {
        const { root, prefix } = live()
        const result = replace(prefix, 'mkdir -p "$p/bin"; echo partial > "$p/bin/.happy-tmp"; echo "ENOSPC" >&2; return 1')
        expect(result.status).not.toBe(0)
        expect(result.stderr).toMatch(/is unchanged/)
        expect(readFileSync(join(prefix, 'bin', 'happy'), 'utf8')).toBe('old')
        expect(() => lstatSync(`${prefix}.new`)).toThrow()
        rmSync(root, { recursive: true, force: true })
    })

    it('refuses an incomplete staged package and keeps the running one', () => {
        const { root, prefix } = live()
        const result = replace(prefix, 'mkdir -p "$p/bin"; echo new > "$p/bin/happy"')
        expect(result.status).not.toBe(0)
        expect(result.stderr).toMatch(/incomplete/)
        expect(readFileSync(join(prefix, 'bin', 'happy'), 'utf8')).toBe('old')
        rmSync(root, { recursive: true, force: true })
    })

    it('refuses to replace a prefix that holds other software', () => {
        const root = mkdtempSync(join(tmpdir(), '.abp-happy-'))
        const prefix = join(root, 'local')
        mkdirSync(join(prefix, 'bin'), { recursive: true })
        mkdirSync(join(prefix, 'other-tool'), { recursive: true })
        writeFileSync(join(prefix, 'bin', 'tool'), 'keep')
        const result = replace(prefix, complete)
        expect(result.status).not.toBe(0)
        expect(result.stderr).toMatch(/not a dedicated Happy prefix/)
        expect(readFileSync(join(prefix, 'bin', 'tool'), 'utf8')).toBe('keep')
        expect(() => lstatSync(`${prefix}.new`)).toThrow()
        rmSync(root, { recursive: true, force: true })
    })

    it('refuses an unmarked Happy install outside the default prefix (it may share lib/node_modules with other packages)', () => {
        const { root, prefix } = live()
        mkdirSync(join(prefix, 'lib', 'node_modules', 'other-package'), { recursive: true })
        const result = replace(prefix, complete, join(root, 'somewhere-else'))
        expect(result.status).not.toBe(0)
        expect(result.stderr).toMatch(/not a dedicated Happy prefix/)
        expect(() => lstatSync(join(prefix, 'lib', 'node_modules', 'other-package'))).not.toThrow()
        rmSync(root, { recursive: true, force: true })
    })

    it('restores the previous package left by an interrupted swap before anything else, even if the retry fails', () => {
        const { root, prefix } = live()
        // Interrupted between the two moves: the live prefix is gone, the good copy is in .old.
        rmSync(`${prefix}.old`, { recursive: true, force: true })
        renameSync(prefix, `${prefix}.old`)
        mkdirSync(join(`${prefix}.new`, 'bin'), { recursive: true })
        const result = replace(prefix, 'echo ENOSPC >&2; return 1')
        expect(result.status).not.toBe(0)
        expect(readFileSync(join(prefix, 'bin', 'happy'), 'utf8')).toBe('old')
        expect(() => lstatSync(`${prefix}.old`)).toThrow()
        rmSync(root, { recursive: true, force: true })
    })

    it('swaps in a complete package, marks the prefix as installer-owned and removes the previous one', () => {
        const { root, prefix } = live()
        const result = replace(prefix, complete)
        expect(result.status).toBe(0)
        expect(readFileSync(join(prefix, 'bin', 'happy'), 'utf8').trim()).toBe('new')
        expect(() => lstatSync(join(prefix, '.abp-happy-prefix'))).not.toThrow()
        expect(() => lstatSync(`${prefix}.old`)).toThrow()
        expect(() => lstatSync(`${prefix}.new`)).toThrow()
        rmSync(root, { recursive: true, force: true })
    })
})

describe('abp-install claude-login', () => {
    const sourced = (snippet: string) => spawnSync('bash', ['-c', `set -euo pipefail; source "$1"; ${snippet}`, 'test', join(here, 'abp-install')], { encoding: 'utf8' })
    const sdk = '/opt/abp/happy/lib/node_modules/@buzzni/happy-cli/node_modules/@anthropic-ai'

    it('resolves the Claude Agent SDK native binary for the machine architecture', () => {
        expect(sourced('claude_binary /opt/abp/happy x86_64').stdout.trim()).toBe(`${sdk}/claude-agent-sdk-linux-x64/claude`)
        expect(sourced('claude_binary /opt/abp/happy aarch64').stdout.trim()).toBe(`${sdk}/claude-agent-sdk-linux-arm64/claude`)
        const other = sourced('claude_binary /opt/abp/happy mips')
        expect(other.status).not.toBe(0)
        expect(other.stderr).toMatch(/unsupported architecture mips/)
    })

    it('runs it as agent-sbx with its own home and config, through the egress proxy', () => {
        const result = bash('abp-install', ['--dry-run', 'claude-login'])
        expect(result.status).toBe(0)
        expect(result.stdout).toMatch(new RegExp(`^\\+ sudo -u agent-sbx env HOME=/home/agent-sbx CLAUDE_CONFIG_DIR=/home/agent-sbx/\\.claude HTTPS_PROXY=http://127\\.0\\.0\\.1:3128 ${sdk.replace(/[.]/g, '\\.')}/claude-agent-sdk-linux-(x64|arm64)/claude$`, 'm'))
        expect(result.stdout).toMatch(/\/login/)
    })
})

describe('abp-install systemd-resolved (the egress proxy resolves only through it)', () => {
    /** systemctl stub: `is-enabled` prints the given state, `is-active` succeeds per `active`, everything else is echoed. */
    const withSystemctl = (state: string, { active = true, installed = true } = {}) => spawnSync('bash', ['-c', `set -euo pipefail; source "$1"; DRY_RUN=0
        systemctl() {
            case "$1" in
                is-enabled) [ -n "${state}" ] && echo "${state}"; return 1 ;;
                is-active) ${active ? 'return 0' : 'return 3'} ;;
                cat) ${installed ? 'return 0' : 'return 1'} ;;
            esac
            echo "+ systemctl $*"
        }
        ensure_resolved_service`, 'test', join(here, 'abp-install')], { encoding: 'utf8' })

    it('unmasks a masked systemd-resolved (OrbStack/Debian images) before enabling it', () => {
        const result = withSystemctl('masked')
        expect(result.status).toBe(0)
        expect(result.stdout.split('\n').filter(Boolean)).toEqual(['+ systemctl unmask systemd-resolved.service', '+ systemctl enable --now systemd-resolved.service'])
        expect(result.stderr).toMatch(/systemd-resolved is masked/)
    })

    it('fails clearly when systemd-resolved is not installed or does not start', () => {
        const missing = withSystemctl('', { installed: false })
        expect(missing.status).not.toBe(0)
        expect(missing.stderr).toMatch(/systemd-resolved is not installed: apt-get install systemd-resolved libnss-resolve/)
        const dead = withSystemctl('enabled', { active: false })
        expect(dead.status).not.toBe(0)
        expect(dead.stderr).toMatch(/systemd-resolved did not start/)
    })
})

describe('abp-uninstall', () => {
    it('keeps profile and journal volumes, configuration and secrets unless --purge', () => {
        const kept = bash('abp-uninstall', ['--dry-run'])
        expect(kept.status).toBe(0)
        expect(kept.stdout).toMatch(/\+ systemctl disable --now abp-happy-daemon\.service/)
        expect(kept.stdout).toMatch(/\+ \/usr\/local\/libexec\/abp\/abp-firewall remove$/m)
        expect(kept.stdout).not.toMatch(/volume rm|rm -rf \/etc\/abp|rm -rf \/var\/lib\/abp/)
        const purged = bash('abp-uninstall', ['--dry-run', '--purge'])
        expect(purged.status).toBe(0)
        expect(purged.stdout).toMatch(/docker volume rm/)
        expect(purged.stdout).toMatch(/\+ rm -rf \/etc\/abp \/var\/lib\/abp/)
    })

    it('fences new sessions, terminates every session process, and only then removes the owner firewall rules', () => {
        const lines = bash('abp-uninstall', ['--dry-run']).stdout.split('\n')
        const at = (text: string) => lines.findIndex((line) => line === text)
        const sudoers = at('+ rm -f /etc/sudoers.d/abp-agent-sbx')
        const daemon = at('+ systemctl disable --now abp-happy-daemon.service')
        const kill = at('+ pkill -KILL -u agent-sbx')
        const rules = at('+ /usr/local/libexec/abp/abp-firewall remove')
        expect(sudoers).toBeGreaterThanOrEqual(0)
        expect(daemon).toBeGreaterThan(sudoers)
        expect(at('+ pkill -TERM -u agent-sbx')).toBeGreaterThan(daemon)
        expect(at('+ pkill -TERM -u agent')).toBeGreaterThan(daemon)
        expect(rules).toBeGreaterThan(kill)
    })

    it('keeps the firewall rules and fails when a session process survives SIGKILL', () => {
        const script = `set -euo pipefail; source "$1"
            run() { printf '+ %s\\n' "$*"; }
            id() { echo 1000; }
            pkill() { :; }
            pgrep() { echo 4242; }
            TERM_WAIT_S=0
            main_uninstall`
        const result = spawnSync('bash', ['-c', script, 'test', join(here, 'abp-uninstall')], { encoding: 'utf8' })
        expect(result.status).toBe(1)
        expect(result.stderr).toMatch(/survived SIGKILL/)
        expect(result.stdout).toMatch(/KEPT the owner firewall rules/)
        expect(result.stdout).not.toMatch(/abp-firewall remove|docker rm|disable --now abp-stack/)
    })
})

const shellcheck = spawnSync('shellcheck', ['--version']).status === 0
describe.skipIf(!shellcheck)('shellcheck', () => {
    it('passes for every shell script', () => {
        const result = spawnSync('shellcheck', ['-x', ...['abp-install', 'abp-uninstall', 'abp-firewall', 'images/browser-entrypoint.sh'].map((file) => join(here, file))], { encoding: 'utf8' })
        expect(result.stdout + result.stderr).toBe('')
        expect(result.status).toBe(0)
    })
})
