import { spawn as crossSpawn } from 'cross-spawn'
import { spawnHappyCLI } from '../utils/spawnHappyCLI'
import { TmuxUtilities } from '../utils/tmux'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { SETUP_TOKEN_BINDING_TYPE, createSetupTokenBindingVerifier } from './setupTokenBindingProof'
import { createAiCredentialRuntime, type AiCredentialCommandResult } from './aiCredentialRuntime'
import { groupAccountIdentity } from './aiCredentialGroupAdapters'
import {
  applyAppliedAiAuthSourceEnv, buildManagedSessionSpawnEnvironment, buildResumedSessionSpawnEnvironment, buildSpawnRequestEnvironment,
  captureSaycodeAgentEnvironment, honorsManagedAiCredentials, overlayManagedCredentialEnvironment, readSetupTokenResumeSelection, verifyAiAuthSelection,
} from './sessionEnv'
import { managedSetupTokenEmail, managedSetupTokenId, setupTokenGroupIdentity, setupTokenRuntimeStatus } from './claudeSetupToken'

vi.mock('cross-spawn', () => ({ spawn: vi.fn(() => ({ pid: 123 })) }))

const A = '0b6f2c1e-1111-4a2b-8c3d-000000000001'
const B = '0b6f2c1e-1111-4a2b-8c3d-000000000002'
const fakeToken = (n: string) => `sk-ant-oat01-FAKE-${n}`
// Synthetic Studio signing key; the envelope format mirrors the Studio collector signer.
const STUDIO = 'https://studio.example.test'
const NOW = 1_800_000_000_000
const signing = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  return { privateKey, publicKeyBase64: spki.toString('base64'), keyId: createHash('sha256').update(spki).digest('hex') }
})()
function bindingGrant(overrides: Record<string, unknown> = {}) {
  const claims = { v: 1, type: SETUP_TOKEN_BINDING_TYPE, aud: `${SETUP_TOKEN_BINDING_TYPE}@${STUDIO}`, keyId: signing.keyId,
    companyId: 'company-1', groupScope: 'company-1', userId: 'user-1', machineId: 'machine-1', managedAccountId: A,
    credentialGeneration: 1, nonce: randomUUID(), issuedAt: NOW - 1_000, expiresAt: NOW + 59_000, ...overrides }
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${encoded}.${sign(null, Buffer.from(encoded), signing.privateKey).toString('base64url')}`
}
const studioVerifier = () => createSetupTokenBindingVerifier({ origin: STUDIO, machineId: 'machine-1', now: () => NOW,
  fetch: (async () => new Response(JSON.stringify({ version: 1, type: 'claude-collector-v1', algorithm: 'Ed25519',
    keyId: signing.keyId, publicKeyBase64: signing.publicKeyBase64, audience: 'n/a' }), { status: 200 })) as typeof fetch })
const MARKER = JSON.stringify({ version: 1, artifact: 'saycode-setup-token-runtime-v1', managedAccountMetadata: true })

// The Studio server's vault row shape (contract-result v1).
function managed(id: string, generation: number, token: string, displayName = `team-${id.slice(-1)}`) {
  return { number: 1, email: managedSetupTokenEmail(id), kind: 'oauth', credentialType: 'setup_token', managedAccountId: id, displayName,
    credentialGeneration: generation, credentials: { claudeAiOauth: { accessToken: token, scopes: ['user:inference'] } },
    config: { oauthAccount: { emailAddress: managedSetupTokenEmail(id) } } }
}
const payload = (...accounts: Array<Record<string, unknown>>) => JSON.stringify({ version: 1, encrypted: false, accounts })
const MANAGED_FIELDS = ['credentialType', 'managedAccountId', 'displayName', 'credentialGeneration'] as const

type Slot = { number: number; email: string; organizationUuid?: string; usageStatus: string; disabled?: boolean; credentials: unknown; config?: unknown } & Record<string, unknown>

// A stateful stand-in for cswap. `marked` keeps managed metadata like the token runtime; an
// unmarked build drops it, as upstream does.
function fakeMachine(initial: Slot[], activeAccountNumber: number | null, options: { runtime?: 'marked' | 'unmarked' | 'missing'; ignoreForce?: boolean; tokenRuntimeStatus?: string; files?: Map<string, string>; binding?: false; env?: Record<string, string>; capabilities?: Record<string, unknown>; listFails?: boolean; clock?: { now: number }; advanceOnExport?: number; advanceOnNonceWrite?: number; durability?: 'missing' | 'file-fails' | 'directory-fails' } = {}) {
  const kind = options.runtime ?? 'marked'
  const state = { slots: [...initial], active: activeAccountNumber }
  const calls: Array<{ command: string; args: string[] }> = []
  const files = options.files ?? new Map<string, string>()
  const syncEvents: string[] = []
  const execFile = vi.fn(async (command: string, args: string[]): Promise<AiCredentialCommandResult> => {
    calls.push({ command, args })
    if (command === 'cswap' && kind === 'missing') throw Object.assign(new Error('not found'), { kind: 'COMMAND_NOT_AVAILABLE' })
    if (command === 'cswap' && args[0] === '--version') return { stdout: 'cswap 0.27.0b1', stderr: '' }
    if (command === 'cswap' && args[0] === 'token-runtime') {
      if (kind !== 'marked') throw Object.assign(new Error('unknown command'), { kind: 'COMMAND_FAILED' })
      if (args[1] === 'status') return { stdout: options.tokenRuntimeStatus ?? JSON.stringify({ version: 1, artifact: 'saycode-setup-token-runtime-v1', accounts: [] }), stderr: '' }
      return { stdout: options.capabilities ? JSON.stringify(options.capabilities) : MARKER, stderr: '' }
    }
    if (command === 'cswap' && args[0] === 'list' && options.listFails) throw Object.assign(new Error('list failed'), { kind: 'COMMAND_FAILED' })
    if (command === 'cswap' && args[0] === 'list') return { stdout: JSON.stringify({ schemaVersion: 1, activeAccountNumber: state.active,
      accounts: state.slots.map(({ credentials: _c, config: _f, ...row }) => ({ ...row, active: row.number === state.active })) }), stderr: '' }
    if (command === 'cswap' && args[0] === 'export' && options.clock && options.advanceOnExport) options.clock.now += options.advanceOnExport
    if (command === 'cswap' && args[0] === 'export') return { stdout: JSON.stringify({ version: 1, encrypted: false, accounts: state.slots }), stderr: '' }
    if (command === 'cswap' && args[0] === 'import') {
      const envelope = JSON.parse(files.get(args[1]!)!)
      for (const account of envelope.accounts) {
        const index = state.slots.findIndex(slot => slot.email === account.email)
        const metadata = kind === 'marked' ? Object.fromEntries(MANAGED_FIELDS.filter(key => key in account).map(key => [key, account[key]])) : {}
        const slot = { number: index >= 0 ? state.slots[index]!.number : state.slots.length + 1, email: account.email, organizationUuid: '',
          usageStatus: 'unavailable', credentials: account.credentials, config: account.config, ...metadata }
        // Like cswap, --force rewrites the account record and so drops its disabled flag.
        if (index < 0) state.slots.push(slot); else if (args.includes('--force') && !options.ignoreForce) state.slots[index] = slot
      }
      return { stdout: '', stderr: '' }
    }
    if (command === 'cswap' && args[0] === 'remove') {
      state.slots = state.slots.filter(slot => slot.number !== Number(args[1]))
      if (state.active === Number(args[1])) state.active = null
      return { stdout: '', stderr: '' }
    }
    if (command === 'cswap' && args[0] === 'disable') { state.slots.find(slot => slot.number === Number(args[1]))!.disabled = true; return { stdout: '', stderr: '' } }
    if (command === 'cswap' && args[0] === 'switch') { state.active = Number(args[1]); return { stdout: '', stderr: '' } }
    return { stdout: '', stderr: '' }
  })
  const runtime = createAiCredentialRuntime({
    homeDir: '/home/operator', now: () => options.clock?.now ?? NOW, env: options.env ?? {}, execFile,
    ...(options.binding === false ? {} : { setupTokenBinding: studioVerifier() }),
    ...(options.durability === 'missing' ? {} : {
      syncFile: async (path: string) => { syncEvents.push('file:' + path); if (options.durability === 'file-fails') throw new Error('sync failed') },
      syncDirectory: async (path: string) => { syncEvents.push('directory:' + path); if (options.durability === 'directory-fails') throw new Error('sync failed') },
    }),
    readFile: vi.fn(async (path: string) => files.get(path) ?? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))),
    writeFile: vi.fn(async (path: string, content: string) => {
      if (path.includes('setup-token-binding-nonces') && options.clock && options.advanceOnNonceWrite) options.clock.now += options.advanceOnNonceWrite
      files.set(path, content)
    }),
    readdir: vi.fn(async () => []), mkdir: vi.fn(async () => undefined),
    rename: vi.fn(async (from: string, to: string) => { if (to.includes('setup-token-binding-nonces')) syncEvents.push('rename:' + to); files.set(to, files.get(from)!); files.delete(from) }),
    chmod: vi.fn(async () => undefined), rm: vi.fn(async (path: string) => { files.delete(path) }),
    makeTempDir: vi.fn(async () => '/tmp/happy-setup-token-fixed'),
    supervisor: { enable: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), status: vi.fn(() => ({ state: 'running' as const, lastErrorKind: null })) },
  })
  return { runtime, calls, state, files, syncEvents }
}
const inference = (calls: Array<{ command: string; args: string[] }>) => calls.filter(call => call.command === 'claude')
const installs = (calls: Array<{ command: string; args: string[] }>) => calls.filter(call => call.command === 'uv' && call.args[0] === 'tool')
const sync = (generation: number, body: string | null) => ({ version: 1 as const, scope: 'company-1', userId: 'user-1', provider: 'claude' as const,
  generation, fingerprint: String(generation).padStart(64, '0'), payload: body })
const stored = (id: string, generation: number, token: string, extra: Partial<Slot> = {}): Slot => {
  const { number: _n, ...account } = managed(id, generation, token)
  return { number: 2, usageStatus: 'unavailable', ...account, ...extra }
}

describe('managed Claude setup-token runtime', () => {
  it.each(['plain', 'tmux'] as const)('refuses a default Claude %s launch when assignment arrives during preparation', async (adapter) => {
    const { runtime } = fakeMachine([], null)
    const env = await runtime.sessionEnvironment('claude')
    expect(env).toEqual({})
    let release!: () => void
    const prepared = new Promise<void>(resolve => { release = resolve })
    const spawn = vi.fn(() => spawnHappyCLI(['claude'], { env }))
    const tmux = new TmuxUtilities('fixture')
    const command = vi.spyOn(tmux, 'executeTmuxCommand').mockResolvedValue({ returncode: 0, stdout: '123', stderr: '', command: [] })
    vi.spyOn(tmux, 'ensureSessionExists').mockImplementation(async () => { await prepared; return true })
    const launching = adapter === 'plain'
      ? (async () => { await prepared; return runtime.launchSession(env, spawn) })()
      : tmux.spawnInTmux(['synthetic-claude'], { sessionName: 'fixture' }, env, start => runtime.launchSession(env, start))
    await runtime.groupSync(sync(1, payload(managed(A, 1, fakeToken('a')))))
    const result = adapter === 'plain'
      ? expect(launching).rejects.toThrow('CLAUDE_SETUP_TOKEN_SELECTION_REQUIRED')
      : expect(launching).resolves.toMatchObject({ success: false, error: expect.stringContaining('CLAUDE_SETUP_TOKEN_SELECTION_REQUIRED') })
    release()
    await result
    expect(spawn).not.toHaveBeenCalled()
    expect(command.mock.calls.some(([args]) => args[0] === 'new-window')).toBe(false)
    await expect(runtime.launchSession(env, spawn)).rejects.toThrow('CLAUDE_SETUP_TOKEN_SELECTION_REQUIRED')
  })

  it('preserves machine-personal, non-Claude and prepared ZAI bypasses at final launch', async () => {
    const { runtime, files } = fakeMachine([], null)
    // The production machine-personal path intentionally skips sessionEnvironment.
    const personal = honorsManagedAiCredentials({ kind: 'machine-personal' }) ? await runtime.sessionEnvironment('claude') : {}
    const codex = await runtime.sessionEnvironment('codex')
    files.set('/home/operator/.happy/trial-ai-credential-leases.json', JSON.stringify({ version: 1,
      leases: { zai: { leaseId: 'synthetic', contentHash: 'a'.repeat(64), bundleVersion: 1 } } }))
    files.set('/home/operator/.happy/zai-claude-env.json', JSON.stringify({ ANTHROPIC_AUTH_TOKEN: 'synthetic-zai',
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', API_TIMEOUT_MS: '3000000',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.7' }))
    const zai = await runtime.sessionEnvironment('claude')
    // The lease is removed before the organization assignment is installed.
    files.delete('/home/operator/.happy/trial-ai-credential-leases.json')
    await runtime.groupSync(sync(1, payload(managed(A, 1, fakeToken('a')))))
    for (const env of [personal, codex, zai]) {
      await runtime.launchSession(env, () => spawnHappyCLI(['claude'], { env }))
      expect(crossSpawn).toHaveBeenLastCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ env }))
    }
  })

  it.each(['revoke', 'generation', 'expiry'] as const)('refuses %s after preparation before the child spawn', async (change) => {
    const clock = { now: NOW }
    const { runtime } = fakeMachine([], null, { clock })
    await runtime.groupSync(sync(1, payload(managed(A, 1, fakeToken('a')))))
    const selection = { kind: 'claude-setup-token' as const, managedAccountId: A, groupScope: 'company-1', credentialGeneration: 1, bindingGrant: bindingGrant() }
    const env = await runtime.sessionEnvironment('claude', selection)
    let release!: () => void
    const prepared = new Promise<void>(resolve => { release = resolve })
    const spawn = vi.fn(() => spawnHappyCLI(['claude'], { env }))
    const launching = (async () => { await prepared; return runtime.launchSession(env, spawn) })()
    if (change === 'revoke') await runtime.groupSync(sync(2, null))
    if (change === 'generation') await runtime.groupSync(sync(2, payload(managed(A, 2, fakeToken('b')))))
    if (change === 'expiry') clock.now += 60_000
    const result = expect(launching).rejects.toThrow(/CLAUDE_SETUP_TOKEN_BINDING/)
    release()
    await result
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each(['revoke', 'generation', 'expiry'] as const)('rechecks %s after actual tmux preparation', async (change) => {
    const clock = { now: NOW }
    const { runtime } = fakeMachine([], null, { clock })
    await runtime.groupSync(sync(1, payload(managed(A, 1, fakeToken('a')))))
    const env = await runtime.sessionEnvironment('claude', { kind: 'claude-setup-token', managedAccountId: A,
      groupScope: 'company-1', credentialGeneration: 1, bindingGrant: bindingGrant() })
    const tmux = new TmuxUtilities('fixture')
    const command = vi.spyOn(tmux, 'executeTmuxCommand').mockResolvedValue({ returncode: 0, stdout: '123', stderr: '', command: [] })
    let release!: () => void
    const preparation = new Promise<boolean>(resolve => { release = () => resolve(true) })
    vi.spyOn(tmux, 'ensureSessionExists').mockReturnValue(preparation)
    const launching = tmux.spawnInTmux(['synthetic-claude'], { sessionName: 'fixture' }, env, start => runtime.launchSession(env, start))
    await vi.waitFor(() => expect(tmux.ensureSessionExists).toHaveBeenCalled())
    if (change === 'revoke') await runtime.groupSync(sync(2, null))
    if (change === 'generation') await runtime.groupSync(sync(2, payload(managed(A, 2, fakeToken('b')))))
    if (change === 'expiry') clock.now += 60_000
    release()
    expect(await launching).toMatchObject({ success: false })
    expect(command.mock.calls.some(([args]) => args[0] === 'new-window')).toBe(false)
    await expect(runtime.launchSession(env, () => spawnHappyCLI(['claude'], { env }))).rejects.toThrow(/CLAUDE_SETUP_TOKEN_BINDING/)
  })

  it('permits a guarded plain fallback when tmux preparation fails before submission', async () => {
    const { runtime } = fakeMachine([], null)
    await runtime.groupSync(sync(1, payload(managed(A, 1, fakeToken('a')))))
    const env = await runtime.sessionEnvironment('claude', { kind: 'claude-setup-token', managedAccountId: A,
      groupScope: 'company-1', credentialGeneration: 1, bindingGrant: bindingGrant() })
    const tmux = new TmuxUtilities('fixture')
    vi.spyOn(tmux, 'executeTmuxCommand').mockResolvedValue({ returncode: 0, stdout: '123', stderr: '', command: [] })
    vi.spyOn(tmux, 'ensureSessionExists').mockRejectedValue(new Error('synthetic tmux unavailable'))
    expect(await tmux.spawnInTmux(['synthetic'], { sessionName: 'fixture' }, env, start => runtime.launchSession(env, start)))
      .toMatchObject({ success: false })
    await runtime.launchSession(env, () => spawnHappyCLI(['claude'], { env }))
    expect(crossSpawn).toHaveBeenLastCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ env }))
  })

  it('checks expiry after the final provider read and permits only one submitted spawn', async () => {
    const options = { clock: { now: NOW }, advanceOnExport: 0 }
    const { runtime } = fakeMachine([], null, options)
    await runtime.groupSync(sync(1, payload(managed(A, 1, fakeToken('a')))))
    const selection = { kind: 'claude-setup-token' as const, managedAccountId: A, groupScope: 'company-1', credentialGeneration: 1, bindingGrant: bindingGrant() }
    const env = await runtime.sessionEnvironment('claude', selection)
    const spawn = vi.fn(() => spawnHappyCLI(['claude'], { env }))
    options.advanceOnExport = 60_000
    await expect(runtime.launchSession(env, spawn)).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_EXPIRED')
    expect(spawn).not.toHaveBeenCalled()
    // Resume has no fresh-grant expiry, but a prepared resume still has one spawn.
    options.advanceOnExport = 0
    const resume = readSetupTokenResumeSelection(captureSaycodeAgentEnvironment(env))!
    const resumed = await runtime.sessionEnvironment('claude', resume.selection, resume.binding)
    await runtime.launchSession(resumed, () => spawnHappyCLI(['claude'], { env: resumed }))
    expect(crossSpawn).toHaveBeenLastCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ env: resumed }))
    await expect(runtime.launchSession(resumed, spawn)).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_REPLAYED')
  })

  it('uses the server synthetic email and company-scoped group identity', () => {
    expect(managedSetupTokenEmail(A)).toBe(`managed-${A}@setup-token.local`)
    expect(managedSetupTokenId(managedSetupTokenEmail(A))).toBe(A)
    expect(managedSetupTokenId('setup-token-1@token.local')).toBeNull()
    expect(groupAccountIdentity('claude', managed(A, 1, fakeToken('a')))).toBe(setupTokenGroupIdentity(A))
    // cswap list rows carry only the email; they must map to the same identity.
    expect(groupAccountIdentity('claude', { email: managedSetupTokenEmail(A) })).toBe(setupTokenGroupIdentity(A))
  })

  it('installs setup-token accounts on an empty machine without inference or usage gating', async () => {
    const { runtime, calls, state } = fakeMachine([], null)
    const receipt = await runtime.groupSync(sync(1, payload(managed(A, 1, fakeToken('a')), { ...managed(B, 1, fakeToken('b')), number: 2 })))
    expect(receipt.reconciled).toBe(true)
    expect(state.slots.map(slot => [slot.managedAccountId, slot.credentialGeneration])).toEqual([[A, 1], [B, 1]])
    expect(state.active).toBe(1)
    expect(inference(calls)).toEqual([])
  })

  it('keeps the personal active account and replaces a group-owned slot on token and on rename-only changes', async () => {
    const personal: Slot = { number: 1, email: 'me@example.com', usageStatus: 'ok', credentials: { claudeAiOauth: { accessToken: 'personal', refreshToken: 'r' } } }
    const { runtime, calls, state } = fakeMachine([personal], 1)
    await runtime.groupSync(sync(1, payload(managed(A, 1, fakeToken('old')))))
    state.slots[1]!.disabled = true
    await runtime.groupSync(sync(2, payload(managed(A, 2, fakeToken('new')))))
    await runtime.groupSync(sync(3, payload(managed(A, 3, fakeToken('new'), 'renamed'))))
    expect(state.active).toBe(1)
    expect(state.slots[0]).toEqual(personal)
    expect(state.slots[1]).toMatchObject({ number: 2, disabled: true, displayName: 'renamed', credentialGeneration: 3,
      credentials: { claudeAiOauth: { accessToken: fakeToken('new') } } })
    expect(inference(calls)).toEqual([])
    expect(calls.filter(call => call.args[0] === 'import').map(call => call.args.includes('--force'))).toEqual([false, true, true])
  })

  it('never takes over a personally imported slot with the same synthetic email', async () => {
    const { runtime, state, calls } = fakeMachine([stored(A, 1, fakeToken('personal'))], 2)
    await expect(runtime.groupSync(sync(1, payload(managed(A, 2, fakeToken('org')))))).rejects.toThrow('AI_GROUP_CREDENTIAL_CONFLICT')
    expect(state.slots[0]!.credentials).toEqual(managed(A, 1, fakeToken('personal')).credentials)
    expect(calls.some(call => call.args[0] === 'import')).toBe(false)
  })

  it('fences stale and conflicting generations against stored metadata', async () => {
    const { runtime, state } = fakeMachine([], null)
    await runtime.groupSync(sync(2, payload(managed(A, 2, fakeToken('two')))))
    await expect(runtime.groupSync(sync(3, payload(managed(A, 1, fakeToken('one')))))).rejects.toThrow('AI_GROUP_GENERATION_STALE')
    await expect(runtime.groupSync(sync(4, payload(managed(A, 2, fakeToken('other')))))).rejects.toThrow('AI_GROUP_GENERATION_CONFLICT')
    expect(state.slots[0]!.credentials).toEqual(managed(A, 2, fakeToken('two')).credentials)
  })

  it('does not acknowledge a replacement whose stored credential is still the old one', async () => {
    const { runtime, state } = fakeMachine([], null, { ignoreForce: true })
    await runtime.groupSync(sync(1, payload(managed(A, 1, fakeToken('old')))))
    await expect(runtime.groupSync(sync(2, payload(managed(A, 2, fakeToken('new')))))).rejects.toThrow('CLAUDE_APPLY_VERIFICATION_FAILED')
    expect(state.slots[0]!.credentials).toEqual(managed(A, 1, fakeToken('old')).credentials)
    expect(await runtime.groupReceipt('company-1', 'claude')).toMatchObject({ generation: 2, reconciled: false })
  })

  it.each(['unmarked', 'missing'] as const)('needs action on an %s runtime before any install or write', async runtimeKind => {
    const { runtime, calls, state } = fakeMachine([], null, { runtime: runtimeKind })
    await expect(runtime.groupSync(sync(1, payload(managed(A, 1, fakeToken('a')))))).rejects.toThrow('CLAUDE_SETUP_TOKEN_UNSUPPORTED')
    expect(installs(calls)).toEqual([])
    expect(state.slots).toEqual([])
    const capabilities = await runtime.capabilities()
    expect(capabilities).toMatchObject({ groupAssignmentVersion: 1, newSessionProfileBinding: false })
    expect(capabilities).not.toHaveProperty('setupTokenSessionBindingVersion')
    expect(capabilities).not.toHaveProperty('setupTokenVersion')
  })

  it('advertises setup-token capability only for the marked runtime', async () => {
    expect(await fakeMachine([], null).runtime.capabilities()).toMatchObject({ setupTokenVersion: 1, setupTokenStatusVersion: 1 })
  })

  it('reports secret-free setup-token status separately from usage', async () => {
    const { runtime } = fakeMachine([stored(A, 1, fakeToken('a'), { number: 1, usageStatus: 'relogin_required' })], 1)
    const status = await runtime.status({ provider: 'claude' }) as Record<string, unknown>
    expect(status.setupToken).toEqual(setupTokenRuntimeStatus([{ number: 1, email: managedSetupTokenEmail(A), usageStatus: 'relogin_required' }], 1))
    expect(status).toMatchObject({ activeAccountStatus: 'unknown', reloginRequiredAccountCount: 0 })
    expect(JSON.stringify(status)).not.toContain('sk-ant-oat01')
  })

  it('gates personal CAS and signed collector capabilities on the actual provider and trusted context', async () => {
    const capabilities={version:1,artifact:'saycode-setup-token-runtime-v1',managedAccountMetadata:true,setupTokenObservation:true,durableProbeBudget:true,personalProbeVersion:1,organizationCollectorVersion:1}
    const env={HAPPY_APLUS_STUDIO_ORIGIN:'https://studio.test'}
    const der=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}) as Buffer
    const key={version:1,type:'claude-collector-v1',algorithm:'Ed25519',keyId:createHash('sha256').update(der).digest('hex'),publicKeyBase64:der.toString('base64'),audience:'claude-collector-v1@https://studio.test'}
    const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify(key)))
    try {
      const supported=await fakeMachine([],null,{env,capabilities,binding:false}).runtime.capabilities('machine')
      expect(supported).toMatchObject({tokenProbeVersion:1,collectorProbeVersion:1,newSessionProfileBinding:false})
      expect(String(fetcher.mock.calls[0][0])).toBe('https://studio.test/api/claude-collector/public-key')
      expect(fetcher.mock.calls[0][1]).not.toHaveProperty('headers')
      const noConfig=await fakeMachine([],null,{capabilities}).runtime.capabilities('machine')
      expect(noConfig).toHaveProperty('tokenProbeVersion',1)
      expect(noConfig).not.toHaveProperty('collectorProbeVersion')
      const old=await fakeMachine([],null).runtime.capabilities('machine')
      expect(old).not.toHaveProperty('tokenProbeVersion')
      fetcher.mockResolvedValue(new Response('{}',{status:503}))
      expect(await fakeMachine([],null,{env,capabilities}).runtime.capabilities('machine')).not.toHaveProperty('collectorProbeVersion')
    }finally{fetcher.mockRestore()}
  })

  it.each(['https://user:pass@studio.test', 'https://studio.test/path', 'https://studio.test?tenant=other', 'https://studio.test#fragment'])(
    'refuses malformed configured collector origin %s before fetching keys', async (origin) => {
      const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected key request'))
      try {
        const capabilities = { version: 1, artifact: 'saycode-setup-token-runtime-v1', organizationCollectorVersion: 1 }
        const { runtime } = fakeMachine([], null, { env: { HAPPY_APLUS_STUDIO_ORIGIN: origin }, capabilities, binding: false })
        expect(await runtime.capabilities('machine')).not.toHaveProperty('collectorProbeVersion')
        expect(fetcher).not.toHaveBeenCalled()
      } finally { fetcher.mockRestore() }
    },
  )

  describe('new-session binding', () => {
    const selection = (overrides: Record<string, unknown> = {}) => ({ kind: 'claude-setup-token' as const, managedAccountId: A,
      groupScope: 'company-1', credentialGeneration: 1, bindingGrant: bindingGrant(overrides) })
    // The slot is installed by this scope's group-sync for user-1, so the journal proves ownership.
    async function assigned(options: Parameters<typeof fakeMachine>[2] = {}, initial: Slot[] = [], active: number | null = null) {
      const machine = fakeMachine(initial, active, options)
      await machine.runtime.groupSync(sync(1, payload(managed(A, 1, fakeToken('a')))))
      return machine
    }

    it('binds a verified grant to only that token, records signed provenance without secrets, and never switches', async () => {
      const personal: Slot = { number: 1, email: 'me@example.com', usageStatus: 'ok', credentials: { claudeAiOauth: { accessToken: 'personal' } } }
      const { runtime, state, calls, files } = await assigned({}, [personal], 1)
      const chosen = selection()
      const env = await runtime.sessionEnvironment('claude', chosen)
      expect(env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: fakeToken('a'), HAPPY_AI_AUTH_SOURCE: 'org-bundle', ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: '' })
      const record = JSON.parse(env.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING!)
      expect(record).toMatchObject({ version: 1, managedAccountId: A, credentialGeneration: 1, groupScope: 'company-1', companyId: 'company-1',
        userId: 'user-1', machineId: 'machine-1', keyId: signing.keyId })
      expect(env.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING).not.toMatch(/sk-ant|\./)
      expect(env.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING).not.toContain(chosen.bindingGrant.split('.')[1]!)
      expect([...files.values()].join('\n')).not.toContain(chosen.bindingGrant)
      expect(state.active).toBe(1)
      expect(calls.some(call => call.args[0] === 'switch')).toBe(false)
      expect(inference(calls)).toEqual([])
    })

    it('lets exactly one of two concurrent spawns consume the same grant; distinct grants for one account both bind', async () => {
      const { runtime } = await assigned()
      const chosen = selection()
      const results = await Promise.allSettled([runtime.sessionEnvironment('claude', chosen), runtime.sessionEnvironment('claude', chosen)])
      expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
      expect(String((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason)).toContain('CLAUDE_SETUP_TOKEN_BINDING_REPLAYED')
      const both = await Promise.all([runtime.sessionEnvironment('claude', selection()), runtime.sessionEnvironment('claude', selection())])
      expect(new Set(both.map(env => JSON.parse(env.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING!).nonce)).size).toBe(2)
    })

    it.each([[], { unexpected: NOW + 60_000 }, { [A]: -1 }])('refuses malformed nonce ledger entries: %j', async (nonces) => {
      const { runtime, files } = await assigned()
      const path = '/home/operator/.happy/setup-token-binding-nonces.json'
      const corrupt = JSON.stringify({ version: 1, nonces })
      files.set(path, corrupt)
      await expect(runtime.sessionEnvironment('claude', selection())).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_LEDGER_INVALID')
      expect(files.get(path)).toBe(corrupt)
    })

    it('flushes the nonce file before rename and its directory before returning the token', async () => {
      const { runtime, syncEvents } = await assigned()
      await runtime.sessionEnvironment('claude', selection())
      expect(syncEvents).toEqual([
        'file:/home/operator/.happy/setup-token-binding-nonces.json.happy-tmp',
        'rename:/home/operator/.happy/setup-token-binding-nonces.json',
        'directory:/home/operator/.happy', 'directory:/home/operator',
      ])
    })

    it.each(['missing', 'file-fails', 'directory-fails'] as const)('returns no token when nonce durability is %s', async (durability) => {
      const { runtime, files, state } = await assigned({ durability })
      const chosen = selection()
      await expect(runtime.sessionEnvironment('claude', chosen)).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE')
      expect(files.has('/home/operator/.happy/setup-token-binding-nonces.json.happy-tmp')).toBe(false)
      const restarted = fakeMachine(state.slots, state.active, { files })
      if (durability === 'directory-fails') {
        await expect(restarted.runtime.sessionEnvironment('claude', chosen)).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_REPLAYED')
      } else {
        expect(files.has('/home/operator/.happy/setup-token-binding-nonces.json')).toBe(false)
        await expect(restarted.runtime.sessionEnvironment('claude', chosen)).resolves.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
      }
    })

    it('rejects a grant that expires while the slot is read, before burning its nonce', async () => {
      const clock = { now: NOW }
      const { runtime, files } = await assigned({ clock, advanceOnExport: 60_000 })
      const chosen = selection()
      await expect(runtime.sessionEnvironment('claude', chosen)).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_EXPIRED')
      expect(files.has('/home/operator/.happy/setup-token-binding-nonces.json')).toBe(false)
    })

    it('rejects a grant that expires during the nonce write: the nonce is burned and no token env is returned', async () => {
      const clock = { now: NOW }
      const { runtime } = await assigned({ clock, advanceOnNonceWrite: 60_000 })
      const chosen = selection()
      await expect(runtime.sessionEnvironment('claude', chosen)).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_EXPIRED')
      clock.now = NOW
      await expect(runtime.sessionEnvironment('claude', chosen)).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_REPLAYED')
    })

    it('resumes from a record without any fresh-grant lifetime check', async () => {
      const clock = { now: NOW }
      const { runtime } = await assigned({ clock })
      const env = await runtime.sessionEnvironment('claude', selection())
      const resume = readSetupTokenResumeSelection(captureSaycodeAgentEnvironment(env))!
      clock.now = NOW + 24 * 3600_000
      expect((await runtime.sessionEnvironment('claude', resume.selection, resume.binding)).CLAUDE_CODE_OAUTH_TOKEN).toBe(fakeToken('a'))
    })

    it('makes each grant one-use, durably across a daemon restart', async () => {
      const { runtime, files, state } = await assigned()
      const chosen = selection()
      await runtime.sessionEnvironment('claude', chosen)
      await expect(runtime.sessionEnvironment('claude', chosen)).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_REPLAYED')
      const restarted = fakeMachine(state.slots, state.active, { files })
      await expect(restarted.runtime.sessionEnvironment('claude', chosen)).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_REPLAYED')
    })

    it.each([
      ['no grant', { bindingGrant: undefined }, {}],
      ['a grant for another user than the assignment', {}, { userId: 'user-2' }],
      ['a grant for another machine', {}, { machineId: 'machine-2' }],
      ['a grant for another account', {}, { managedAccountId: B }],
      ['a grant for another scope', {}, { groupScope: 'company-2' }],
      ['a grant for another generation', {}, { credentialGeneration: 2 }],
      ['an expired grant', {}, { expiresAt: NOW }],
      ['a collector grant type', {}, { type: 'claude-collector-v1' }],
    ] as const)('refuses %s', async (_label, selectionOverrides, claimOverrides) => {
      const { runtime } = await assigned()
      await expect(runtime.sessionEnvironment('claude', { ...selection(claimOverrides), ...selectionOverrides })).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE')
    })

    it('refuses without a configured trusted origin, for a personal slot, and for another scope', async () => {
      const unconfigured = await assigned({ binding: false })
      await expect(unconfigured.runtime.sessionEnvironment('claude', selection())).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE')
      const personal = fakeMachine([stored(A, 1, fakeToken('a'))], null)
      await expect(personal.runtime.sessionEnvironment('claude', selection())).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE')
      const { runtime } = await assigned()
      await expect(runtime.sessionEnvironment('claude', { ...selection({ groupScope: 'company-2' }), groupScope: 'company-2' })).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE')
    })

    it('refuses once the assignment is revoked or still pending', async () => {
      const revoked = await assigned()
      await revoked.runtime.groupSync({ ...sync(2, null as never), payload: null })
      await expect(revoked.runtime.sessionEnvironment('claude', selection())).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE')
      const pending = await assigned({ ignoreForce: true })
      await expect(pending.runtime.groupSync(sync(2, payload(managed(A, 2, fakeToken('b')))))).rejects.toThrow()
      await expect(pending.runtime.sessionEnvironment('claude', selection())).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE')
    })

    it.each([
      ['a disabled slot', (state: { slots: Slot[]; active: number | null }) => { state.slots[0]!.disabled = true }],
      ['a slot without managed metadata', (state: { slots: Slot[]; active: number | null }) => { delete state.slots[0]!.managedAccountId }],
      ['a removed slot', (state: { slots: Slot[]; active: number | null }) => { state.slots.length = 0; state.active = null }],
    ] as const)('fails closed for %s', async (_label, mutate) => {
      const { runtime, state } = await assigned()
      mutate(state)
      await expect(runtime.sessionEnvironment('claude', selection())).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE')
    })

    it('fails closed on an unmarked runtime and for a non-Claude agent', async () => {
      const { runtime } = fakeMachine([stored(A, 1, fakeToken('a'))], null, { runtime: 'unmarked' })
      await expect(runtime.sessionEnvironment('claude', selection())).rejects.toThrow('CLAUDE_SETUP_TOKEN_UNSUPPORTED')
      const marked = await assigned()
      await expect(marked.runtime.sessionEnvironment('codex', selection())).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE')
    })


    it('wins over inherited and requested credentials on spawn (plain and tmux) and resumes from the record after a restart', async () => {
      const { runtime, state, files } = await assigned()
      const chosen = selection()
      const managedEnv = await runtime.sessionEnvironment('claude', chosen)
      const inherited = { ANTHROPIC_API_KEY: 'sk-ant-api-INHERITED', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-INHERITED', ANTHROPIC_MODEL: 'opus',
        HAPPY_AI_AUTH_SETUP_TOKEN_BINDING: '{"forged":true}', HAPPY_AI_AUTH_SOURCE: 'personal-subscription' }
      const requested = buildSpawnRequestEnvironment({}, { ANTHROPIC_BASE_URL: 'https://proxy.invalid', ANTHROPIC_AUTH_TOKEN: 'x', HAPPY_AI_AUTH_SETUP_TOKEN_BINDING: '{}' })
      // Both run.ts spawn paths build exactly this env (tmux passes every key with -e, so '' overwrites server values).
      const child = applyAppliedAiAuthSourceEnv(buildManagedSessionSpawnEnvironment(inherited, requested, managedEnv), true)
      expect(child).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: fakeToken('a'), ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '',
        ANTHROPIC_MODEL: 'opus', HAPPY_AI_AUTH_SOURCE: 'org-bundle' })
      expect(verifyAiAuthSelection(chosen, child).rejection).toBeUndefined()
      // sessions.json keeps only the captured record; a restarted daemon rehydrates and resumes from it, no grant needed.
      const persisted = captureSaycodeAgentEnvironment(child)!
      expect(JSON.stringify(persisted)).not.toMatch(/sk-ant/)
      expect(JSON.stringify(persisted)).not.toContain(chosen.bindingGrant)
      const restored = captureSaycodeAgentEnvironment(JSON.parse(JSON.stringify(persisted)))
      const resume = readSetupTokenResumeSelection(restored)!
      expect(resume.selection).not.toHaveProperty('bindingGrant')
      const restarted = fakeMachine(state.slots, state.active, { files })
      const resumedManaged = await restarted.runtime.sessionEnvironment('claude', resume.selection, resume.binding)
      const resumed = overlayManagedCredentialEnvironment(buildResumedSessionSpawnEnvironment({ inherited, explicit: {},
        runtime: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-REQUESTED', ANTHROPIC_API_KEY: 'k' }, agentEnvironment: restored, sessionId: 's1' }), resumedManaged)
      expect(resumed).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: fakeToken('a'), ANTHROPIC_API_KEY: '', HAPPY_AI_AUTH_SETUP_TOKEN_BINDING: persisted.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING })
      // A token replacement makes the same resume stale; a revocation makes it unavailable. Never the default.
      await restarted.runtime.groupSync(sync(2, payload(managed(A, 2, fakeToken('replaced')))))
      await expect(restarted.runtime.sessionEnvironment('claude', resume.selection, resume.binding)).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_STALE')
      await restarted.runtime.groupSync({ ...sync(3, null as never), payload: null })
      await expect(restarted.runtime.sessionEnvironment('claude', resume.selection, resume.binding)).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE')
    })

    it('refuses a resume whose recorded owner no longer holds the assignment', async () => {
      const { runtime } = await assigned()
      const env = await runtime.sessionEnvironment('claude', selection())
      const resume = readSetupTokenResumeSelection(captureSaycodeAgentEnvironment(env))!
      await expect(runtime.sessionEnvironment('claude', resume.selection, { ...resume.binding, userId: 'user-2' })).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE')
      await expect(runtime.sessionEnvironment('claude', resume.selection, { ...resume.binding, credentialGeneration: 2 })).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE')
    })

    it('advertises binding only with the marked runtime and a verifiable Studio key', async () => {
      expect(await fakeMachine([], null).runtime.capabilities()).toMatchObject({ newSessionProfileBinding: true, setupTokenSessionBindingVersion: 1 })
      for (const machine of [fakeMachine([], null, { binding: false }), fakeMachine([], null, { runtime: 'unmarked' })]) {
        const capabilities = await machine.runtime.capabilities()
        expect(capabilities).toMatchObject({ newSessionProfileBinding: false })
        expect(capabilities).not.toHaveProperty('setupTokenSessionBindingVersion')
      }
    })
  })

  describe('unbound Claude launches and resumes on an org-managed default', () => {
    it('refuses a launch or resume without a binding when the active default is a managed setup-token slot', async () => {
      // An empty machine activates the first managed slot, so the machine default is org material.
      const { runtime, state } = fakeMachine([], null)
      await runtime.groupSync(sync(1, payload(managed(A, 1, fakeToken('a')))))
      expect(state.active).toBe(1)
      // A new launch (Desktop, agent facade, automation, fork) and a resume without a record share this path.
      await expect(runtime.sessionEnvironment('claude')).rejects.toThrow('CLAUDE_SETUP_TOKEN_SELECTION_REQUIRED')
      await expect(runtime.sessionEnvironment(undefined)).rejects.toThrow('CLAUDE_SETUP_TOKEN_SELECTION_REQUIRED')
      // Other agents are unaffected.
      expect(await runtime.sessionEnvironment('codex')).toEqual({})
    })

    it('refuses an unbound launch while a personal account is active if an assignment desires a managed setup-token', async () => {
      const personal: Slot = { number: 1, email: 'me@example.com', usageStatus: 'ok', credentials: { claudeAiOauth: { accessToken: 'personal', refreshToken: 'r' } } }
      const { runtime, state, calls } = fakeMachine([personal], 1)
      await runtime.groupSync(sync(1, payload(managed(A, 1, fakeToken('a')))))
      expect(state.active).toBe(1)
      const before = calls.length
      await expect(runtime.sessionEnvironment('claude')).rejects.toThrow('CLAUDE_SETUP_TOKEN_SELECTION_REQUIRED')
      // The decision comes from the journal alone: no cswap call (and no usage fetch) per launch.
      expect(calls.slice(before)).toEqual([])
      // Revoking the assignment restores the personal default.
      await runtime.groupSync(sync(2, null))
      expect(await runtime.sessionEnvironment('claude')).toEqual({})
    })

    it('leaves ordinary OAuth group assignments and personal defaults unchanged', async () => {
      const personal: Slot = { number: 1, email: 'me@example.com', usageStatus: 'ok', credentials: { claudeAiOauth: { accessToken: 'personal', refreshToken: 'r' } } }
      const { runtime } = fakeMachine([personal], 1)
      await runtime.groupSync(sync(1, payload({ number: 1, email: 'shared@example.com', organizationUuid: '', credentials: { claudeAiOauth: { accessToken: 'oauth', refreshToken: 'r' } }, config: {} })))
      expect(await runtime.sessionEnvironment('claude')).toEqual({})
    })

    // A journal written before the `managed` projection existed.
    const JOURNAL = '/home/operator/.happy/ai-credential-groups.json'
    const legacyJournal = (desired: string[], pending = false) => new Map([[JOURNAL, JSON.stringify({ version: 1, entries: [{ scope: 'company-1', userId: 'user-1',
      provider: 'claude', generation: 1, fingerprint: '1'.padStart(64, '0'), desired, owned: pending ? [] : desired, pending, payloadDigest: null }] })]])
    const legacyHash = (email: string) => createHash('sha256').update(JSON.stringify(['claude', email, ''])).digest('hex')
    const personalSlot: Slot = { number: 1, email: 'me@example.com', usageStatus: 'ok', credentials: { claudeAiOauth: { accessToken: 'personal', refreshToken: 'r' } } }

    it.each([
      ['the managed-ID identity', setupTokenGroupIdentity(A)],
      ['the pre-projection email identity', legacyHash(managedSetupTokenEmail(A))],
    ])('migrates an old journal that desires a managed slot via %s and refuses the unbound launch', async (_label, identity) => {
      const files = legacyJournal([identity])
      const { runtime, calls } = fakeMachine([personalSlot, stored(A, 1, fakeToken('a'))], 1, { files })
      await expect(runtime.sessionEnvironment('claude')).rejects.toThrow('CLAUDE_SETUP_TOKEN_SELECTION_REQUIRED')
      expect(JSON.parse(files.get(JOURNAL)!).entries[0].managed).toEqual([identity])
      const before = calls.length
      await expect(runtime.sessionEnvironment('claude')).rejects.toThrow('CLAUDE_SETUP_TOKEN_SELECTION_REQUIRED')
      expect(calls.slice(before)).toEqual([])
    })

    it('migrates an old ordinary OAuth journal without blocking it, once', async () => {
      const files = legacyJournal([legacyHash('shared@example.com')])
      const shared: Slot = { number: 2, email: 'shared@example.com', usageStatus: 'ok', credentials: { claudeAiOauth: { accessToken: 'o', refreshToken: 'r' } } }
      const { runtime, calls } = fakeMachine([personalSlot, shared], 1, { files })
      expect(await runtime.sessionEnvironment('claude')).toEqual({})
      expect(JSON.parse(files.get(JOURNAL)!).entries[0].managed).toEqual([])
      const before = calls.length
      expect(await runtime.sessionEnvironment('claude')).toEqual({})
      expect(calls.slice(before)).toEqual([])
    })

    it('refuses an unknown old assignment when the roster cannot be read, even with a personal login, and does not migrate', async () => {
      const files = legacyJournal([legacyHash('shared@example.com')])
      files.set('/home/operator/.claude.json', JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } }))
      const { runtime } = fakeMachine([personalSlot], 1, { files, listFails: true })
      await expect(runtime.sessionEnvironment('claude')).rejects.toThrow('CLAUDE_SETUP_TOKEN_ASSIGNMENT_UNRESOLVED')
      expect(JSON.parse(files.get(JOURNAL)!).entries[0]).not.toHaveProperty('managed')
    })

    it('refuses a pending old assignment whose desired slots are not installed yet, and does not mark it unmanaged', async () => {
      const files = legacyJournal([setupTokenGroupIdentity(A)], true)
      const { runtime } = fakeMachine([personalSlot], 1, { files })
      await expect(runtime.sessionEnvironment('claude')).rejects.toThrow('CLAUDE_SETUP_TOKEN_ASSIGNMENT_UNRESOLVED')
      expect(JSON.parse(files.get(JOURNAL)!).entries[0]).not.toHaveProperty('managed')
    })

    it('projects an empty or revoked old assignment without the roster and keeps the personal default', async () => {
      const files = legacyJournal([])
      const { runtime, calls } = fakeMachine([personalSlot], 1, { files, listFails: true })
      expect(await runtime.sessionEnvironment('claude')).toEqual({})
      expect(JSON.parse(files.get(JOURNAL)!).entries[0].managed).toEqual([])
      expect(calls.filter(call => call.args[0] === 'list')).toEqual([])
    })

    it('does not consult cswap at all on a machine without group assignments', async () => {
      const { runtime, calls } = fakeMachine([stored(A, 1, fakeToken('a'), { number: 1 })], 1)
      expect(await runtime.sessionEnvironment('claude')).toEqual({})
      expect(calls.filter(call => call.command === 'cswap')).toEqual([])
    })
  })

  it('keeps ownership per group scope: another scope cannot replace or revoke a slot it did not install', async () => {
    const { runtime, state } = fakeMachine([], null)
    await runtime.groupSync(sync(1, payload(managed(A, 1, fakeToken('a')))))
    const other = { ...sync(1, payload(managed(A, 2, fakeToken('b')))), scope: 'company-2' }
    await expect(runtime.groupSync(other)).rejects.toThrow('AI_GROUP_CREDENTIAL_CONFLICT')
    // Unassigning the second scope leaves the first scope's slot in place.
    await runtime.groupSync({ ...sync(2, null as never), scope: 'company-2', payload: null })
    expect(state.slots.map(slot => slot.managedAccountId)).toEqual([A])
    expect(state.slots[0]!.credentials).toEqual(managed(A, 1, fakeToken('a')).credentials)
  })
})
