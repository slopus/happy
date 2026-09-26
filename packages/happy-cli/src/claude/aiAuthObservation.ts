/**
 * Whether this run's Claude login is one the organisation deployed — as far as
 * a run can **observe** it.
 *
 * The daemon cannot tell an organisation bundle from any other login on the
 * machine (both are just "the CLI's own login"), so it writes `unknown`. The
 * run itself can ask Claude Code which account it loaded (`accountInfo()`) and
 * compare that with what the daemon recorded when it applied the bundle
 * (`~/.happy/ai-credential-provenance.json`, fenced by the apply generation).
 *
 * That is still an observation, not proof that each request was billed to that
 * account: Claude Code reads its token and its account metadata from different
 * places, and the metadata can outlive a token swap. So the result is its own
 * source, `org-bundle-observed`, never `org-bundle` — that one stays reserved
 * for a spawn the daemon isolated to the bundle itself. And it travels
 * in-process to the usage events only; it must never reach
 * `HAPPY_AI_AUTH_SOURCE`, which is what approves an explicit selection.
 *
 * Every doubt resolves to "not observed", which reports `unknown`.
 */
import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { readActiveClaudeProvenance, type ActiveClaudeProvenance } from '@/daemon/aiCredentialProvenance'
import { CLAUDE_AUTH_OVERRIDE_ENV_KEYS } from '@/claude/utils/claudeAuthOverrideEnv'

export const ORG_BUNDLE_OBSERVED = 'org-bundle-observed'
export type ObservedAiAuthSource = typeof ORG_BUNDLE_OBSERVED

/** The login Claude Code keeps beside its token (`oauthAccount` in its global config). */
export type LiveOauthAccount = {
    email: string
    organizationUuid: string
    organizationName: string
}

const MANAGED_KEY = '/login managed key'
const DEFAULT_TIMEOUT_MS = 5_000

/**
 * The shape Claude Code reports for its own login, and nothing else.
 *
 * - a first-party backend (a 3P provider or gateway authenticates elsewhere);
 * - no key beside the login except the one `/login` manages — an
 *   `ANTHROPIC_API_KEY` or `apiKeyHelper` may be what is actually spent;
 * - no token from the environment (`CLAUDE_CODE_OAUTH_TOKEN`,
 *   `ANTHROPIC_AUTH_TOKEN`): nobody deployed those.
 */
function isOwnLogin(account: AccountInfo): boolean {
    if (account.apiProvider !== undefined && account.apiProvider !== 'firstParty') return false
    if (account.apiKeySource !== undefined && account.apiKeySource !== MANAGED_KEY) return false
    if (account.tokenSource === undefined || account.tokenSource === 'claude.ai') return true
    return account.tokenSource === 'none' && account.apiKeySource === MANAGED_KEY
}

export function classifyObservedLogin(input: {
    account: AccountInfo | undefined
    live: LiveOauthAccount | null
    provenance: ActiveClaudeProvenance | null
}): boolean {
    const { account, live, provenance } = input
    if (!account || !live || !provenance || !isOwnLogin(account)) return false
    if (typeof account.email !== 'string' || account.email === '') return false
    const organizationName = account.organization ?? ''
    // accountInfo() names the organization; only the login metadata carries its
    // uuid. Both must agree before the uuid can stand in for the name.
    if (live.email !== account.email || live.organizationName !== organizationName) return false
    return provenance.identities.has(JSON.stringify([live.email, live.organizationUuid, organizationName]))
}

function isMissing(error: unknown): boolean {
    return (error as { code?: unknown } | null)?.code === 'ENOENT'
}

/**
 * Claude Code's global config: `<config root>/.config.json` when that legacy
 * file exists, otherwise `.claude.json` beside the config root. An empty or
 * relative `CLAUDE_CONFIG_DIR` is resolved by Claude against a cwd this cannot
 * be sure of, so it is not guessed.
 *
 * An env that authenticates or routes Claude on its own (`ANTHROPIC_BASE_URL`,
 * `ANTHROPIC_CUSTOM_HEADERS`, …) has no such login to report: `accountInfo()`
 * still names the stored account, but the requests go wherever the env says.
 */
export async function readLiveOauthAccount(input: {
    env: Record<string, string | undefined>
    homeDir: string
    readFile: (path: string) => Promise<string>
}): Promise<LiveOauthAccount | null> {
    try {
        if (CLAUDE_AUTH_OVERRIDE_ENV_KEYS.some((key) => input.env[key])) return null
        const configDir = input.env.CLAUDE_CONFIG_DIR
        if (configDir !== undefined && (configDir === '' || !isAbsolute(configDir))) return null
        const legacy = join(configDir ?? join(input.homeDir, '.claude'), '.config.json')
        let raw: string
        try {
            raw = await input.readFile(legacy)
        } catch (error) {
            if (!isMissing(error)) return null
            raw = await input.readFile(join(configDir ?? input.homeDir, '.claude.json'))
        }
        const oauthAccount = (JSON.parse(raw) as { oauthAccount?: Record<string, unknown> } | null)?.oauthAccount
        const email = oauthAccount?.emailAddress
        if (typeof email !== 'string' || email === '') return null
        const text = (value: unknown) => (typeof value === 'string' ? value : '')
        return {
            email,
            organizationUuid: text(oauthAccount?.organizationUuid),
            organizationName: text(oauthAccount?.organizationName),
        }
    } catch {
        return null
    }
}

export type ClaudeAuthObservation = {
    /** The observed source for a usage event created now, if any. */
    current(): ObservedAiAuthSource | undefined
    /** Each turn's `system/init` states the key it runs on; any change ends the observation. */
    noteTurnApiKeySource(apiKeySource: unknown): void
    /** The run is over. Nothing it learns afterwards counts. */
    dispose(): void
}

function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs) })
    return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

export function startClaudeAuthObservation(deps: {
    accountInfo: () => Promise<AccountInfo | undefined>
    readProvenance: () => Promise<ActiveClaudeProvenance | null>
    readLiveAccount: () => Promise<LiveOauthAccount | null>
    timeoutMs?: number
}): ClaudeAuthObservation {
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let disposed = false
    // Once anything contradicts the observation it stays off for this run.
    let contradicted = false
    let observed: { turnApiKeySource: string; generation: number } | null = null
    // A turn's deployment recheck in flight: nothing is reported until it answers.
    let pendingRechecks = 0
    const turnApiKeySources: unknown[] = []

    const contradict = () => {
        contradicted = true
        observed = null
    }

    const observe = async () => {
        const before = await deps.readProvenance()
        const account = await deps.accountInfo()
        const live = await deps.readLiveAccount()
        // An apply that started meanwhile bumped the generation: the login read
        // above may belong to either side of it.
        const after = await deps.readProvenance()
        if (!before || !after || before.generation !== after.generation) return null
        if (!classifyObservedLogin({ account, live, provenance: after })) return null
        return { turnApiKeySource: account?.apiKeySource ?? 'none', generation: after.generation }
    }

    void withDeadline(observe(), timeoutMs)
        .catch(() => null)
        .then((result) => {
            if (contradicted || !result) return
            if (turnApiKeySources.some((source) => source !== result.turnApiKeySource)) {
                contradict()
                return
            }
            observed = result
        })

    return {
        current: () => (!disposed && observed && pendingRechecks === 0 ? ORG_BUNDLE_OBSERVED : undefined),
        noteTurnApiKeySource(apiKeySource) {
            if (disposed) return
            if (!observed) {
                turnApiKeySources.push(apiKeySource)
                return
            }
            if (apiKeySource !== observed.turnApiKeySource) {
                contradict()
                return
            }
            const generation = observed.generation
            pendingRechecks += 1
            void withDeadline(Promise.resolve().then(() => deps.readProvenance()), timeoutMs)
                .catch(() => undefined)
                .then((provenance) => {
                    pendingRechecks -= 1
                    if (provenance?.generation !== generation) contradict()
                })
        },
        dispose() {
            disposed = true
        },
    }
}

/** The observation for one SDK query, against this process's home and Claude config. */
export function observeClaudeQueryAuth(query: { accountInfo(): Promise<AccountInfo> }): ClaudeAuthObservation {
    const homeDir = homedir()
    // The query's child got a copy of process.env at spawn; so does this.
    const env = { ...process.env }
    const readText = (path: string) => readFile(path, 'utf8')
    return startClaudeAuthObservation({
        accountInfo: () => query.accountInfo(),
        readProvenance: () => readActiveClaudeProvenance({ homeDir, readFile: readText }),
        readLiveAccount: () => readLiveOauthAccount({ env, homeDir, readFile: readText }),
    })
}
