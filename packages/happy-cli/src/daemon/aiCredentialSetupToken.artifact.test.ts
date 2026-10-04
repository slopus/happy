/**
 * Real marked cswap token runtime, driven by the real Happy runtime as a subprocess.
 *
 * Opt-in: set HAPPY_CSWAP_TOKEN_RUNTIME_WHEEL to a built `saycode-setup-token-runtime-v1`
 * wheel. The wheel is installed into a temp dir and run through a wrapper that pins
 * HOME/XDG/CLAUDE_CONFIG_DIR into that dir, forces the file credential backend (never
 * the macOS Keychain) and makes every network entry fail. `claude` is a logging stub,
 * so no inference can run. Tokens and signing keys are synthetic.
 */
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createAiCredentialRuntime, runAiCredentialCommand } from './aiCredentialRuntime'
import { managedSetupTokenEmail } from './claudeSetupToken'
import { captureSaycodeAgentEnvironment, readSetupTokenResumeSelection } from './sessionEnv'
import { SETUP_TOKEN_BINDING_TYPE, createSetupTokenBindingVerifier } from './setupTokenBindingProof'

const WHEEL = process.env.HAPPY_CSWAP_TOKEN_RUNTIME_WHEEL
// Explicit source-only regression mode: uses existing deps, never installs.
const SOURCE = process.env.HAPPY_CSWAP_TOKEN_RUNTIME_SOURCE
const PYTHON = process.env.HAPPY_CSWAP_TOKEN_RUNTIME_PYTHON
const A = '0b6f2c1e-1111-4a2b-8c3d-000000000001'
const B = '0b6f2c1e-1111-4a2b-8c3d-000000000002'
const STUDIO = 'https://studio.example.test'
const token = (name: string) => `sk-ant-oat01-ARTIFACT-${name}`

function managed(id: string, generation: number, secret: string, number = 1) {
  return { number, email: managedSetupTokenEmail(id), kind: 'oauth', credentialType: 'setup_token', managedAccountId: id,
    displayName: `team ${id.slice(-1)}`, credentialGeneration: generation,
    credentials: { claudeAiOauth: { accessToken: secret, scopes: ['user:inference'] } },
    config: { oauthAccount: { emailAddress: managedSetupTokenEmail(id) } } }
}
const payload = (...accounts: unknown[]) => JSON.stringify({ version: 1, encrypted: false, accounts })
const sync = (generation: number, body: string | null) => ({ version: 1 as const, scope: 'company-1', userId: 'user-1',
  provider: 'claude' as const, generation, fingerprint: String(generation).padStart(64, '0'), payload: body })

describe.skipIf(!WHEEL && !(SOURCE && PYTHON))('marked cswap artifact: group-sync, status, binding and resume (offline, file backend)', () => {
  let root = ''
  const saved: Record<string, string | undefined> = {}
  const signing = (() => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const spki = publicKey.export({ format: 'der', type: 'spki' })
    return { privateKey, publicKeyBase64: spki.toString('base64'), keyId: createHash('sha256').update(spki).digest('hex') }
  })()
  const grant = (managedAccountId: string, credentialGeneration: number) => {
    const now = Date.now()
    const claims = { v: 1, type: SETUP_TOKEN_BINDING_TYPE, aud: `${SETUP_TOKEN_BINDING_TYPE}@${STUDIO}`, keyId: signing.keyId,
      companyId: 'company-1', groupScope: 'company-1', userId: 'user-1', machineId: 'machine-1', managedAccountId,
      credentialGeneration, nonce: randomUUID(), issuedAt: now - 1_000, expiresAt: now + 59_000 }
    const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `${encoded}.${sign(null, Buffer.from(encoded), signing.privateKey).toString('base64url')}`
  }

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'happy-cswap-artifact-')))
    const home = join(root, 'home'), bin = join(root, 'bin'), install = join(root, 'install')
    for (const dir of [home, bin, install]) mkdirSync(dir, { recursive: true })
    const python = SOURCE && PYTHON ? PYTHON : execFileSync('uv', ['python', 'find', '3.12'], { encoding: 'utf8' }).trim()
    if (!SOURCE) execFileSync('uv', ['pip', 'install', '--offline', '--no-deps', '--python', python, '--target', install, WHEEL!], { stdio: 'pipe' })
    writeFileSync(join(bin, 'cswap'), `#!${python}
import os, socket, sys, urllib.error, urllib.request
home = ${JSON.stringify(home)}
for key in ('CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'):
    os.environ.pop(key, None)
os.environ.update(HOME=home, XDG_DATA_HOME=home + '/data', XDG_CONFIG_HOME=home + '/config', CLAUDE_CONFIG_DIR=home + '/claude')
sys.platform = 'linux'  # file credential backend, never the Keychain
# Behave like an offline machine (cswap handles this) and record every attempt.
def forbidden(*args, **kwargs):
    with open(${JSON.stringify(join(root, 'network-attempts.log'))}, 'a') as log:
        log.write(repr(args[0])[:200] + '\\n')
    raise urllib.error.URLError('network disabled in artifact integration')
urllib.request.urlopen = urllib.request.build_opener = forbidden
socket.create_connection = lambda *args, **kwargs: (_ for _ in ()).throw(OSError('network disabled in artifact integration'))
sys.path.insert(0, ${JSON.stringify(SOURCE ? join(SOURCE, 'src') : install)})
import claude_swap
assert claude_swap.__file__.startswith(${JSON.stringify(SOURCE ? join(SOURCE, 'src') : install)})
# Real provider transport/bookkeeping; only the HTTP peer is synthetic.
if os.environ.get('HAPPY_TEST_PROBE_TIMEOUT') == '1' and sys.argv[1:3] == ['token-runtime', 'collect']:
    import time
    class TimeoutPeer:
        def open(self, request, timeout):
            assert timeout <= 10
            time.sleep(timeout)
            raise TimeoutError('synthetic transport timeout')
    urllib.request.build_opener = lambda *args: TimeoutPeer()
from claude_swap.cli import main
sys.argv = ['cswap'] + sys.argv[1:]
sys.exit(main())
`)
    // A logging stand-in for the Claude CLI. `auth logout` clears the temp live login like the real one; anything else is a no-op.
    writeFileSync(join(bin, 'claude'), `#!${python}
import json, os, sys
open(${JSON.stringify(join(root, 'claude-calls.log'))}, 'a').write(' '.join(sys.argv[1:]) + '\\n')
if sys.argv[1:3] == ['auth', 'logout']:
    config = ${JSON.stringify(join(home, 'claude'))}
    try: os.remove(os.path.join(config, '.credentials.json'))
    except FileNotFoundError: pass
    path = os.path.join(config, '.claude.json')
    if os.path.exists(path):
        data = json.load(open(path)); data.pop('oauthAccount', None); json.dump(data, open(path, 'w'))
`)
    // Source tests only need uv's read-only version/interpreter queries.
    if (SOURCE) {
      writeFileSync(join(bin, 'uv'), `#!/bin/sh\ncase "$1" in\n--version) echo 'uv fixture' ;;\npython) echo '${python}' ;;\n*) exit 1 ;;\nesac\n`)
    } else {
      const uvPythonDir = execFileSync('uv', ['python', 'dir'], { encoding: 'utf8' }).trim()
      writeFileSync(join(bin, 'uv'), `#!/bin/sh\nUV_PYTHON_INSTALL_DIR=${JSON.stringify(uvPythonDir)} exec ${JSON.stringify(execFileSync('sh', ['-c', 'command -v uv'], { encoding: 'utf8' }).trim())} "$@"\n`)
    }
    for (const name of ['cswap', 'claude', 'uv']) chmodSync(join(bin, name), 0o755)
    for (const key of ['PATH', 'HOME', 'UV_TOOL_BIN_DIR', 'CLAUDE_CONFIG_DIR', 'XDG_DATA_HOME', 'XDG_BIN_HOME']) saved[key] = process.env[key]
    Object.assign(process.env, { PATH: `${bin}:/usr/bin:/bin`, HOME: home, UV_TOOL_BIN_DIR: bin, CLAUDE_CONFIG_DIR: join(home, 'claude') })
    delete process.env.XDG_DATA_HOME; delete process.env.XDG_BIN_HOME
    // Only the wrapper may answer to `cswap`.
    expect(execFileSync('sh', ['-c', 'command -v cswap'], { encoding: 'utf8' }).trim()).toBe(join(bin, 'cswap'))
  }, 120_000)

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    if (root) rmSync(root, { recursive: true, force: true })
  })

  const failures: string[] = []
  function make() {
    const home = join(root, 'home')
    const supervisor = { enable: async () => undefined, stop: async () => undefined, status: () => ({ state: 'stopped' as const, lastErrorKind: null }) }
    const verifier = createSetupTokenBindingVerifier({ origin: STUDIO, machineId: 'machine-1',
      fetch: (async () => new Response(JSON.stringify({ version: 1, algorithm: 'Ed25519', keyId: signing.keyId, publicKeyBase64: signing.publicKeyBase64 }))) as typeof fetch })
    // The production dependency set, with a log of failing command verbs for diagnosis (no arguments, no output).
    return createAiCredentialRuntime({
      homeDir: home, now: Date.now, env: { ...process.env }, supervisor: supervisor as never, setupTokenBinding: verifier,
      execFile: async (command, args, options) => {
        try { return await runAiCredentialCommand(command, args, options, spawn) }
        catch (error) { failures.push(`${command} ${args[0] ?? ''} ${(error as { kind?: string }).kind ?? ''}`); throw error }
      },
      readFile: path => readFile(path, 'utf8'), readdir: path => readdir(path),
      syncFile: async path => { const file = await open(path, 'r+'); try { await file.sync() } finally { await file.close() } },
      syncDirectory: async path => { const directory = await open(path, 'r'); try { await directory.sync() } finally { await directory.close() } },
      writeFile: async (path, content, options) => { await writeFile(path, content, options) },
      mkdir, rename, chmod, rm, makeTempDir: () => mkdtemp(join(root, 'stage-')),
    })
  }

  it('applies, reports, binds one-use, resumes, goes stale on replacement and refuses after revoke', async () => {
    const runtime = make()
    const step = async <T>(label: string, run: () => Promise<T>) => {
      try { return await run() } catch (error) { throw new Error(`${label}: ${(error as Error).message}; failed commands: ${failures.join(' | ')}`) }
    }

    expect(await runtime.capabilities()).toMatchObject({ setupTokenVersion: 1, setupTokenStatusVersion: 1, newSessionProfileBinding: true, setupTokenSessionBindingVersion: 1 })

    // Group-sync installs both managed rows on an empty machine; the receipt is reconciled.
    expect(await step('initial group-sync', () => runtime.groupSync(sync(1, payload(managed(A, 1, token('a1')), managed(B, 1, token('b1'), 2))))))
      .toMatchObject({ generation: 1, reconciled: true })
    const status = await runtime.status({ provider: 'claude' }) as Record<string, any>
    expect(status.setupToken.accounts.map((row: { managedAccountId: string }) => row.managedAccountId).sort()).toEqual([A, B])
    expect(status.tokenRuntime.state).toBe('available')
    expect(status.tokenRuntime.accounts.filter((row: { managedAccountId?: string }) => row.managedAccountId).length).toBe(2)
    expect(JSON.stringify(status)).not.toContain('sk-ant-oat01')

    // The empty machine now defaults to a managed slot, so an unbound launch is refused, not run on org material.
    await expect(runtime.sessionEnvironment('claude')).rejects.toThrow('CLAUDE_SETUP_TOKEN_SELECTION_REQUIRED')

    // A signed grant binds a new session to exactly that slot, once.
    const selection = { kind: 'claude-setup-token' as const, managedAccountId: A, groupScope: 'company-1', credentialGeneration: 1, bindingGrant: grant(A, 1) }
    const env = await runtime.sessionEnvironment('claude', selection)
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(token('a1'))
    await expect(runtime.sessionEnvironment('claude', selection)).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_REPLAYED')
    const persisted = captureSaycodeAgentEnvironment(env)!
    expect(JSON.stringify(persisted)).not.toMatch(/sk-ant|\.[A-Za-z0-9_-]{40,}/)

    // A daemon restart (new runtime, same home) resumes from the record alone.
    const restarted = make()
    const resume = readSetupTokenResumeSelection(captureSaycodeAgentEnvironment(JSON.parse(JSON.stringify(persisted))))!
    expect((await restarted.sessionEnvironment('claude', resume.selection, resume.binding)).CLAUDE_CODE_OAUTH_TOKEN).toBe(token('a1'))
    await expect(restarted.sessionEnvironment('claude', selection)).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_REPLAYED')

    // Replacement through the provider: the old binding is stale, a new grant binds the new token.
    expect(await step('replacement group-sync', () => restarted.groupSync(sync(2, payload(managed(A, 2, token('a2')), managed(B, 1, token('b1'), 2))))))
      .toMatchObject({ generation: 2, reconciled: true })
    await expect(restarted.sessionEnvironment('claude', resume.selection, resume.binding)).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_STALE')
    await runAiCredentialCommand('cswap', ['switch', '2', '--json'])
    const providerStatus = JSON.parse((await runAiCredentialCommand('cswap', ['token-runtime', 'status'])).stdout)
    expect(providerStatus.accounts.find((a: { managedAccountId?: string }) => a.managedAccountId === A).credentialGeneration).toBe(2)
    const next = await restarted.sessionEnvironment('claude', { ...selection, credentialGeneration: 2, bindingGrant: grant(A, 2) })
    expect(next.CLAUDE_CODE_OAUTH_TOKEN).toBe(token('a2'))

    // Revocation removes only this scope's slots and refuses the binding.
    expect(await step('revoke group-sync', () => restarted.groupSync(sync(3, null)))).toMatchObject({ generation: 3, reconciled: true })
    const after = await restarted.status({ provider: 'claude' }) as Record<string, any>
    expect(after.setupToken).toBeUndefined()
    await expect(restarted.sessionEnvironment('claude', { ...selection, credentialGeneration: 2, bindingGrant: grant(A, 2) }))
      .rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE')

    // Nothing ran inference; only a sign-out of the removed last slot may have reached `claude`.
    const calls = existsSync(join(root, 'claude-calls.log')) ? readFileSync(join(root, 'claude-calls.log'), 'utf8') : ''
    expect(calls).not.toContain('--print')
    // Every network entry was intercepted; none can have reached a server.
    const attempts = existsSync(join(root, 'network-attempts.log')) ? readFileSync(join(root, 'network-attempts.log'), 'utf8').trim().split('\n').filter(Boolean) : []
    console.info(`[artifact] intercepted network attempts: ${attempts.length}`)
  }, 300_000)
  it('persists personal transport timeout spending and backoff before the outer process deadline', async () => {
    await runAiCredentialCommand('cswap', ['add-token', token('personal-timeout'), '--email', 'timeout@token.local'])
    const readStatus = async () => JSON.parse((await runAiCredentialCommand('cswap', ['token-runtime', 'status'])).stdout)
    const row = (await readStatus()).accounts.find((a: { roster: { email: string } }) => a.roster.email === 'timeout@token.local')
    const request = { version: 1, accountRef: row.accountRef, credentialGeneration: row.credentialGeneration }
    const savedTimeout = process.env.HAPPY_TEST_PROBE_TIMEOUT
    process.env.HAPPY_TEST_PROBE_TIMEOUT = '1'
    try {
      const runtime = make()
      await runtime.tokenProbe({ ...request, operation: 'consent', enabled: true, ackCost: true })
      const result = await runtime.tokenProbe({ ...request, operation: 'collect' })
      expect(result).not.toHaveProperty('error')
      // Another Python process reopens the durable state: not an in-memory assertion.
      const after = await readStatus()
      const observed = after.accounts.find((a: { accountRef: string }) => a.accountRef === row.accountRef)
      expect(observed.probeBudget).toMatchObject({ accountUsed24h: 1, failureStreak: 1 })
      expect(observed.observation.reason).toBe('transport_failed')
      expect(Date.parse(observed.probeBudget.nextProbeAt)).toBeGreaterThan(Date.now() + 1_700_000)
      expect(after.budget.machineUsed24h).toBeGreaterThanOrEqual(1)
    } finally {
      if (savedTimeout === undefined) delete process.env.HAPPY_TEST_PROBE_TIMEOUT
      else process.env.HAPPY_TEST_PROBE_TIMEOUT = savedTimeout
    }
  }, 40_000)

})
