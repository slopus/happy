import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk'
import {
    AI_CREDENTIAL_PROVENANCE_PATH,
    serializeAppliedClaudeProvenance,
    type ActiveClaudeProvenance,
} from '@/daemon/aiCredentialProvenance'
import { CLAUDE_AUTH_OVERRIDE_ENV_KEYS } from '@/claude/utils/claudeAuthOverrideEnv'
import {
    ORG_BUNDLE_OBSERVED,
    classifyObservedLogin,
    observeClaudeQueryAuth,
    readLiveOauthAccount,
    startClaudeAuthObservation,
    type LiveOauthAccount,
} from './aiAuthObservation'

const provenance: ActiveClaudeProvenance = {
    companyId: 'co-1',
    bundleId: 'bundle-1',
    bundleVersion: 3,
    generation: 7,
    identities: new Set([JSON.stringify(['a@corp.com', 'org-a', 'Corp Inc'])]),
}

function withIdentities(...extra: Array<[string, string, string]>): ActiveClaudeProvenance {
    return {
        ...provenance,
        identities: new Set([...provenance.identities, ...extra.map((identity) => JSON.stringify(identity))]),
    }
}

// What Claude Code reports for a claude.ai subscription login: no tokenSource,
// no apiKeySource, the account's email and organization name.
const subscriber: AccountInfo = { email: 'a@corp.com', organization: 'Corp Inc', subscriptionType: 'max' }
const live: LiveOauthAccount = { email: 'a@corp.com', organizationUuid: 'org-a', organizationName: 'Corp Inc' }

describe('classifyObservedLogin', () => {
    it('accepts a subscription login that is one of the deployed bundle accounts', () => {
        expect(classifyObservedLogin({ account: subscriber, live, provenance })).toBe(true)
    })

    it('accepts a console login whose key Claude Code manages itself', () => {
        expect(classifyObservedLogin({
            account: { ...subscriber, tokenSource: 'none', apiKeySource: '/login managed key' },
            live,
            provenance,
        })).toBe(true)
    })

    it.each<[string, AccountInfo]>([
        ['a third-party provider', { ...subscriber, apiProvider: 'bedrock' }],
        ['an enterprise gateway', { ...subscriber, apiProvider: 'gateway' }],
        ['an ANTHROPIC_API_KEY beside the login — that key may be what is spent', {
            ...subscriber, apiKeySource: 'ANTHROPIC_API_KEY',
        }],
        ['an apiKeyHelper', { ...subscriber, apiKeySource: 'apiKeyHelper' }],
        ['a CLAUDE_CODE_OAUTH_TOKEN — a token nobody deployed', {
            ...subscriber, tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN',
        }],
        ['an ANTHROPIC_AUTH_TOKEN', { ...subscriber, tokenSource: 'ANTHROPIC_AUTH_TOKEN' }],
        ['tokenSource none without a managed key', { ...subscriber, tokenSource: 'none' }],
        ['no email', { organization: 'Corp Inc' }],
        ['an account outside the bundle', { ...subscriber, email: 'someone@else.com' }],
        ['the same email in another organization', { ...subscriber, organization: 'Personal' }],
    ])('rejects %s', (_label, account) => {
        expect(classifyObservedLogin({
            account,
            live: { ...live, email: account.email ?? '', organizationName: account.organization ?? '' },
            provenance,
        })).toBe(false)
    })

    it('rejects when Claude Code reports no account at all', () => {
        expect(classifyObservedLogin({ account: undefined, live, provenance })).toBe(false)
    })

    it('rejects without a fenced deployment record', () => {
        expect(classifyObservedLogin({ account: subscriber, live, provenance: null })).toBe(false)
    })

    it('rejects when the login metadata cannot be read', () => {
        expect(classifyObservedLogin({ account: subscriber, live: null, provenance })).toBe(false)
    })

    it('rejects when the login metadata names another account than Claude Code reported', () => {
        // Both accounts are in the bundle, so only the agreement check can reject.
        expect(classifyObservedLogin({
            account: subscriber,
            live: { ...live, email: 'b@corp.com' },
            provenance: withIdentities(['b@corp.com', 'org-a', 'Corp Inc']),
        })).toBe(false)
    })

    it('rejects when the login metadata names another organization than Claude Code reported', () => {
        expect(classifyObservedLogin({
            account: subscriber,
            live: { ...live, organizationName: 'Renamed Org' },
            provenance: withIdentities(['a@corp.com', 'org-a', 'Renamed Org']),
        })).toBe(false)
    })

    it('rejects an empty email even if a record carried one', () => {
        expect(classifyObservedLogin({
            account: { ...subscriber, email: '' },
            live: { ...live, email: '' },
            provenance: withIdentities(['', 'org-a', 'Corp Inc']),
        })).toBe(false)
    })

    it('rejects an organization with the deployed name but another uuid — names can collide', () => {
        expect(classifyObservedLogin({
            account: subscriber,
            live: { ...live, organizationUuid: 'org-lookalike' },
            provenance,
        })).toBe(false)
    })
})

function files(entries: Record<string, string>) {
    return async (path: string) => {
        if (path in entries) return entries[path]!
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    }
}

const oauthAccount = JSON.stringify({
    oauthAccount: { emailAddress: 'a@corp.com', organizationUuid: 'org-a', organizationName: 'Corp Inc' },
})

describe('readLiveOauthAccount — where Claude Code keeps the login', () => {
    it('reads ~/.claude.json by default', async () => {
        await expect(readLiveOauthAccount({
            env: {},
            homeDir: '/home/u',
            readFile: files({ '/home/u/.claude.json': oauthAccount }),
        })).resolves.toEqual(live)
    })

    it('prefers the legacy .config.json inside the config root when it exists', async () => {
        await expect(readLiveOauthAccount({
            env: {},
            homeDir: '/home/u',
            readFile: files({
                '/home/u/.claude/.config.json': oauthAccount,
                '/home/u/.claude.json': JSON.stringify({ oauthAccount: { emailAddress: 'other@x.com' } }),
            }),
        })).resolves.toEqual(live)
    })

    it('follows CLAUDE_CONFIG_DIR', async () => {
        await expect(readLiveOauthAccount({
            env: { CLAUDE_CONFIG_DIR: '/cfg' },
            homeDir: '/home/u',
            readFile: files({ '/cfg/.claude.json': oauthAccount, '/home/u/.claude.json': '{}' }),
        })).resolves.toEqual(live)
    })

    it.each(['', 'relative/dir'])('gives up on CLAUDE_CONFIG_DIR=%j rather than guess what Claude resolved', async (dir) => {
        // Every place a naive join could land holds a valid login, so only the
        // guard can make this null.
        await expect(readLiveOauthAccount({
            env: { CLAUDE_CONFIG_DIR: dir },
            homeDir: '/home/u',
            readFile: async () => oauthAccount,
        })).resolves.toBeNull()
    })

    it.each(CLAUDE_AUTH_OVERRIDE_ENV_KEYS)('returns null when %s authenticates or routes Claude on its own', async (key) => {
        // accountInfo() still names the stored login; the requests go elsewhere.
        await expect(readLiveOauthAccount({
            env: { [key]: 'set' },
            homeDir: '/home/u',
            readFile: files({ '/home/u/.claude.json': oauthAccount }),
        })).resolves.toBeNull()
    })

    it('returns null when there is no login', async () => {
        await expect(readLiveOauthAccount({
            env: {},
            homeDir: '/home/u',
            readFile: files({ '/home/u/.claude.json': '{}' }),
        })).resolves.toBeNull()
    })

    it('returns null instead of reading the default file when the legacy file is unreadable', async () => {
        await expect(readLiveOauthAccount({
            env: {},
            homeDir: '/home/u',
            readFile: async (path) => {
                if (path === '/home/u/.claude/.config.json') throw Object.assign(new Error('denied'), { code: 'EACCES' })
                return oauthAccount
            },
        })).resolves.toBeNull()
    })
})

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((r) => { resolve = r })
    return { promise, resolve }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function observationDeps(overrides: Partial<Parameters<typeof startClaudeAuthObservation>[0]> = {}) {
    return {
        accountInfo: async () => subscriber,
        readProvenance: async () => provenance,
        readLiveAccount: async () => live,
        ...overrides,
    }
}

describe('startClaudeAuthObservation — one per provider run', () => {
    it('reports nothing until the observation has finished', async () => {
        const account = deferred<AccountInfo | undefined>()
        const observation = startClaudeAuthObservation(observationDeps({ accountInfo: () => account.promise }))
        expect(observation.current()).toBeUndefined()
        account.resolve(subscriber)
        await flush()
        expect(observation.current()).toBe(ORG_BUNDLE_OBSERVED)
    })

    it('reports nothing for a login it could not place', async () => {
        const observation = startClaudeAuthObservation(observationDeps({
            accountInfo: async () => ({ ...subscriber, email: 'someone@else.com' }),
        }))
        await flush()
        expect(observation.current()).toBeUndefined()
    })

    it('never throws when Claude Code refuses to answer', async () => {
        const observation = startClaudeAuthObservation(observationDeps({
            accountInfo: async () => { throw new Error('query closed') },
        }))
        await flush()
        expect(observation.current()).toBeUndefined()
    })

    it('gives up after the deadline', async () => {
        const account = deferred<AccountInfo | undefined>()
        const observation = startClaudeAuthObservation(observationDeps({
            accountInfo: () => account.promise,
            timeoutMs: 5,
        }))
        await new Promise((r) => setTimeout(r, 20))
        account.resolve(subscriber)
        await flush()
        expect(observation.current()).toBeUndefined()
    })

    it('ignores an answer that arrives after the run ended', async () => {
        const account = deferred<AccountInfo | undefined>()
        const observation = startClaudeAuthObservation(observationDeps({ accountInfo: () => account.promise }))
        observation.dispose()
        account.resolve(subscriber)
        await flush()
        expect(observation.current()).toBeUndefined()
    })

    it('stops reporting once the run ends', async () => {
        const observation = startClaudeAuthObservation(observationDeps())
        await flush()
        observation.dispose()
        expect(observation.current()).toBeUndefined()
    })

    it('rejects when a credential apply started while it was looking', async () => {
        let reads = 0
        const observation = startClaudeAuthObservation(observationDeps({
            readProvenance: async () => ({ ...provenance, generation: 7 + reads++ }),
        }))
        await flush()
        expect(observation.current()).toBeUndefined()
    })

    describe('each turn restates which key it runs on', () => {
        it('keeps reporting while every turn runs on the observed login', async () => {
            const observation = startClaudeAuthObservation(observationDeps())
            observation.noteTurnApiKeySource('none')
            await flush()
            observation.noteTurnApiKeySource('none')
            await flush()
            expect(observation.current()).toBe(ORG_BUNDLE_OBSERVED)
        })

        it('stops for good when a later turn runs on a different key', async () => {
            const observation = startClaudeAuthObservation(observationDeps())
            await flush()
            observation.noteTurnApiKeySource('ANTHROPIC_API_KEY')
            expect(observation.current()).toBeUndefined()
            observation.noteTurnApiKeySource('none')
            await flush()
            expect(observation.current()).toBeUndefined()
        })

        it('holds a turn that began before the observation finished against it', async () => {
            const account = deferred<AccountInfo | undefined>()
            const observation = startClaudeAuthObservation(observationDeps({ accountInfo: () => account.promise }))
            observation.noteTurnApiKeySource('apiKeyHelper')
            account.resolve(subscriber)
            await flush()
            expect(observation.current()).toBeUndefined()
        })

        it('matches a managed console key against its own turn value', async () => {
            const observation = startClaudeAuthObservation(observationDeps({
                accountInfo: async () => ({ ...subscriber, tokenSource: 'none', apiKeySource: '/login managed key' }),
            }))
            observation.noteTurnApiKeySource('/login managed key')
            await flush()
            expect(observation.current()).toBe(ORG_BUNDLE_OBSERVED)
        })

        it('reports nothing while a turn is still rechecking the deployment', async () => {
            const recheck = deferred<ActiveClaudeProvenance | null>()
            let reads = 0
            const observation = startClaudeAuthObservation(observationDeps({
                readProvenance: () => (++reads <= 2 ? Promise.resolve(provenance) : recheck.promise),
            }))
            await flush()
            observation.noteTurnApiKeySource('none')
            expect(observation.current()).toBeUndefined()
            recheck.resolve(provenance)
            await flush()
            expect(observation.current()).toBe(ORG_BUNDLE_OBSERVED)
        })

        it('stops for good when a recheck does not answer in time — a late answer does not revive it', async () => {
            const late = deferred<ActiveClaudeProvenance | null>()
            let reads = 0
            const observation = startClaudeAuthObservation(observationDeps({
                readProvenance: () => (++reads <= 2 ? Promise.resolve(provenance) : late.promise),
                timeoutMs: 5,
            }))
            await flush()
            observation.noteTurnApiKeySource('none')
            await new Promise((r) => setTimeout(r, 20))
            late.resolve(provenance)
            await flush()
            expect(observation.current()).toBeUndefined()
        })

        it('never throws from a turn, even when the recheck throws synchronously', async () => {
            let reads = 0
            const observation = startClaudeAuthObservation(observationDeps({
                readProvenance: () => {
                    if (++reads <= 2) return Promise.resolve(provenance)
                    throw new Error('EACCES')
                },
            }))
            await flush()
            expect(() => observation.noteTurnApiKeySource('none')).not.toThrow()
            await flush()
            expect(observation.current()).toBeUndefined()
        })

        it('stops for good when a later turn finds the deployment replaced', async () => {
            let generation = 7
            const observation = startClaudeAuthObservation(observationDeps({
                readProvenance: async () => ({ ...provenance, generation }),
            }))
            await flush()
            expect(observation.current()).toBe(ORG_BUNDLE_OBSERVED)
            generation = 8
            observation.noteTurnApiKeySource('none')
            await flush()
            expect(observation.current()).toBeUndefined()
            generation = 7
            observation.noteTurnApiKeySource('none')
            await flush()
            expect(observation.current()).toBeUndefined()
        })
    })
})

describe('observeClaudeQueryAuth — this process, as the query child sees it', () => {
    let home: string | undefined

    afterEach(async () => {
        vi.unstubAllEnvs()
        if (home) await rm(home, { recursive: true, force: true })
        home = undefined
    })

    // A machine right after an org bundle apply: the login, its fenced record.
    async function machineWithAppliedBundle() {
        home = await mkdtemp(join(tmpdir(), 'ai-auth-observation-'))
        const configDir = join(home, 'claude-config')
        await mkdir(configDir, { recursive: true })
        await mkdir(join(home, '.happy'), { recursive: true })
        await writeFile(join(configDir, '.claude.json'), oauthAccount)
        await writeFile(join(home, AI_CREDENTIAL_PROVENANCE_PATH), serializeAppliedClaudeProvenance({
            ...provenance,
            identities: provenance.identities,
        }))
        await writeFile(
            join(home, '.happy', 'ai-credential-apply-generations.json'),
            JSON.stringify({ version: 1, generations: { claude: provenance.generation } }),
        )
        vi.stubEnv('HOME', home)
        vi.stubEnv('CLAUDE_CONFIG_DIR', configDir)
        for (const key of CLAUDE_AUTH_OVERRIDE_ENV_KEYS) vi.stubEnv(key, '')
    }

    const query = { accountInfo: async () => subscriber }
    const settle = () => new Promise((r) => setTimeout(r, 50))

    it('observes the deployed login', async () => {
        await machineWithAppliedBundle()
        const observation = observeClaudeQueryAuth(query)
        await settle()
        expect(observation.current()).toBe(ORG_BUNDLE_OBSERVED)
    })

    it.each([
        ['ANTHROPIC_BASE_URL', 'http://127.0.0.1:9/proxy'],
        ['ANTHROPIC_CUSTOM_HEADERS', 'x-api-key: proxy-key'],
    ])('observes nothing when %s routes the requests elsewhere', async (key, value) => {
        await machineWithAppliedBundle()
        // How claudeRemote applies claudeEnvVars before starting the query.
        vi.stubEnv(key, value)
        const observation = observeClaudeQueryAuth(query)
        await settle()
        expect(observation.current()).toBeUndefined()
    })
})
