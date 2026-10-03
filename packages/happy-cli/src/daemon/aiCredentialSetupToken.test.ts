import { describe, expect, it, vi } from 'vitest'
import { createAiCredentialRuntime, type AiCredentialCommandResult } from './aiCredentialRuntime'
import { groupAccountIdentity } from './aiCredentialGroupAdapters'
import { managedSetupTokenEmail, managedSetupTokenId, setupTokenGroupIdentity, setupTokenRuntimeStatus } from './claudeSetupToken'

const A = '0b6f2c1e-1111-4a2b-8c3d-000000000001'
const B = '0b6f2c1e-1111-4a2b-8c3d-000000000002'
const fakeToken = (n: string) => `sk-ant-oat01-FAKE-${n}`
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
function fakeMachine(initial: Slot[], activeAccountNumber: number | null, options: { runtime?: 'marked' | 'unmarked' | 'missing'; ignoreForce?: boolean } = {}) {
  const kind = options.runtime ?? 'marked'
  const state = { slots: [...initial], active: activeAccountNumber }
  const calls: Array<{ command: string; args: string[] }> = []
  const files = new Map<string, string>()
  const execFile = vi.fn(async (command: string, args: string[]): Promise<AiCredentialCommandResult> => {
    calls.push({ command, args })
    if (command === 'cswap' && kind === 'missing') throw Object.assign(new Error('not found'), { kind: 'COMMAND_NOT_AVAILABLE' })
    if (command === 'cswap' && args[0] === '--version') return { stdout: 'cswap 0.27.0b1', stderr: '' }
    if (command === 'cswap' && args[0] === 'token-runtime') {
      if (kind !== 'marked') throw Object.assign(new Error('unknown command'), { kind: 'COMMAND_FAILED' })
      return { stdout: MARKER, stderr: '' }
    }
    if (command === 'cswap' && args[0] === 'list') return { stdout: JSON.stringify({ schemaVersion: 1, activeAccountNumber: state.active,
      accounts: state.slots.map(({ credentials: _c, config: _f, ...row }) => ({ ...row, active: row.number === state.active })) }), stderr: '' }
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
    if (command === 'cswap' && args[0] === 'disable') { state.slots.find(slot => slot.number === Number(args[1]))!.disabled = true; return { stdout: '', stderr: '' } }
    if (command === 'cswap' && args[0] === 'switch') { state.active = Number(args[1]); return { stdout: '', stderr: '' } }
    return { stdout: '', stderr: '' }
  })
  const runtime = createAiCredentialRuntime({
    homeDir: '/home/operator', now: () => 0, env: {}, execFile,
    readFile: vi.fn(async (path: string) => files.get(path) ?? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))),
    writeFile: vi.fn(async (path: string, content: string) => { files.set(path, content) }),
    readdir: vi.fn(async () => []), mkdir: vi.fn(async () => undefined),
    rename: vi.fn(async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from) }),
    chmod: vi.fn(async () => undefined), rm: vi.fn(async (path: string) => { files.delete(path) }),
    makeTempDir: vi.fn(async () => '/tmp/happy-setup-token-fixed'),
    supervisor: { enable: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), status: vi.fn(() => ({ state: 'running' as const, lastErrorKind: null })) },
  })
  return { runtime, calls, state, files }
}
const inference = (calls: Array<{ command: string; args: string[] }>) => calls.filter(call => call.command === 'claude')
const installs = (calls: Array<{ command: string; args: string[] }>) => calls.filter(call => call.command === 'uv' && call.args[0] === 'tool')
const sync = (generation: number, body: string) => ({ version: 1 as const, scope: 'company-1', userId: 'user-1', provider: 'claude' as const,
  generation, fingerprint: String(generation).padStart(64, '0'), payload: body })
const stored = (id: string, generation: number, token: string, extra: Partial<Slot> = {}): Slot => {
  const { number: _n, ...account } = managed(id, generation, token)
  return { number: 2, usageStatus: 'unavailable', ...account, ...extra }
}

describe('managed Claude setup-token runtime', () => {
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

  describe('new-session binding', () => {
    const selection = { kind: 'claude-setup-token' as const, managedAccountId: A }

    it('returns only the bound token with every other Claude auth override cleared', async () => {
      const personal: Slot = { number: 1, email: 'me@example.com', usageStatus: 'ok', credentials: { claudeAiOauth: { accessToken: 'personal' } } }
      const { runtime, state, calls } = fakeMachine([personal, stored(A, 1, fakeToken('a'))], 1)
      const env = await runtime.sessionEnvironment('claude', selection)
      expect(env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: fakeToken('a'), HAPPY_AI_AUTH_SOURCE: 'org-bundle', ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: '' })
      // Binding never switches the machine's active account or runs inference.
      expect(state.active).toBe(1)
      expect(calls.some(call => call.args[0] === 'switch')).toBe(false)
      expect(inference(calls)).toEqual([])
    })

    it.each([
      ['a disabled slot', [stored(A, 1, fakeToken('a'), { disabled: true })], 'marked'],
      ['a slot without managed metadata', [{ ...stored(A, 1, fakeToken('a')), managedAccountId: undefined }], 'marked'],
      ['a missing slot', [stored(B, 1, fakeToken('b'))], 'marked'],
      ['an unmarked runtime', [stored(A, 1, fakeToken('a'))], 'unmarked'],
    ] as const)('fails closed for %s', async (_label, slots, runtimeKind) => {
      const { runtime } = fakeMachine([...slots] as Slot[], null, { runtime: runtimeKind })
      await expect(runtime.sessionEnvironment('claude', selection)).rejects.toThrow(/CLAUDE_SETUP_TOKEN_(BINDING_UNAVAILABLE|UNSUPPORTED)/)
    })

    it('refuses a non-Claude agent and leaves unselected spawns unchanged', async () => {
      const { runtime } = fakeMachine([stored(A, 1, fakeToken('a'))], null)
      await expect(runtime.sessionEnvironment('codex', selection)).rejects.toThrow('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE')
      expect(await runtime.sessionEnvironment('claude')).toEqual({})
    })

    it('advertises binding only with the marked runtime', async () => {
      expect(await fakeMachine([], null).runtime.capabilities()).toMatchObject({ newSessionProfileBinding: true, setupTokenSessionBindingVersion: 1 })
      expect(await fakeMachine([], null, { runtime: 'unmarked' }).runtime.capabilities()).toMatchObject({ newSessionProfileBinding: false })
    })
  })
})
