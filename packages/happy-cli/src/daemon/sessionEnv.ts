/**
 * Session lineage environment variables must never be inherited implicitly.
 *
 * HAPPY_RECONNECT_* attaches a child to an EXISTING happy session and
 * HAPPY_FORK* attaches provider-conversation lineage. They are only valid
 * when the daemon sets them explicitly for one specific spawn (resumeSession
 * / fork RPC). If they leak through `...process.env` — e.g. a resumed child
 * auto-restarts the daemon on version mismatch, and the daemon inherits the
 * child's env — every session the daemon spawns afterwards reconnects to the
 * same happy session. That is the 2026-07-19 incident: chats from every
 * project queued into one session and replayed each other's prompts.
 *
 * APLUS_SESSION_* is the session's own web URL/id exported for agent shell
 * subprocesses (sessionUrlEnv.ts). Scrub it here so a daemon-spawned session
 * starts without stale identity; the child session factory then writes its
 * confirmed current id.
 *
 * SAYCODE_AGENT_* grants per-session orchestration scope. A daemon restarted
 * by one agent must not leak that agent's root/depth/id into unrelated spawns;
 * tracked sessions re-add their captured capability explicitly on resume.
 *
 * HAPPY_CHECKPOINT_* binds protected checkpoint state to one daemon-verified
 * project/worktree. It follows the same no-implicit-inheritance rule.
 */
import { CLAUDE_AUTH_OVERRIDE_ENV_KEYS } from '@/claude/utils/claudeAuthOverrideEnv'
import {
    CHECKPOINT_SPAWN_CONTEXT_ENV_KEY,
    readCheckpointSpawnContext,
} from '@/checkpoint/checkpointSpawnContext'
import {
    HAPPY_AI_AUTH_CONNECTION_VERSION_ENV,
    HAPPY_AI_AUTH_SOURCE_ENV,
    normalizeAiAuthSource,
    resolveAppliedAiAuthSource,
    type AiAuthSource,
} from '@/usage/aiAuthSource'
import { ADDITIONAL_DIRECTORIES_ENV, readAdditionalDirectoriesEnvironment } from '@/utils/additionalDirectoriesEnv'

// 'HAPPY_INITIAL_' covers HAPPY_INITIAL_PROMPT(_LOCAL_ID) and the
// HAPPY_INITIAL_MODEL / HAPPY_INITIAL_EFFORT spawn seeds.
// 'HAPPY_AI_AUTH_' covers HAPPY_AI_AUTH_SOURCE and
// HAPPY_AI_AUTH_CONNECTION_VERSION: which credential a session is actually
// spending is decided per spawn, never inherited. A daemon restarted by a
// child inherits that child's environment, and an un-scrubbed value would make
// every later session on the machine meter its tokens against somebody else's
// credential.
export const SESSION_LINEAGE_ENV_PREFIXES = ['HAPPY_RECONNECT_', 'HAPPY_FORK', 'HAPPY_CREATED_BY', 'HAPPY_INITIAL_', 'HAPPY_DEFERRED_CONTINUATION_', 'HAPPY_AUTOMATION_', 'HAPPY_ADDITIONAL_DIRECTORIES', 'HAPPY_CHECKPOINT_', 'HAPPY_AI_AUTH_', 'APLUS_SESSION_', 'SAYCODE_AGENT_'] as const

const SAYCODE_AGENT_ENV_KEYS = [
    'SAYCODE_AGENT_ENV',
    'SAYCODE_AGENT_ROOT',
    // The tree siblings may live in (saycode-cli 0.4.0, Desktop ADR-061). Without it a
    // resumed hub silently shrinks back to its own worktree.
    'SAYCODE_AGENT_SCOPE',
    'SAYCODE_AGENT_DEPTH',
    'SAYCODE_AGENT_MAX_SPAWN',
    'SAYCODE_AGENT_ID',
] as const

type SaycodeAgentEnvironmentKey = typeof SAYCODE_AGENT_ENV_KEYS[number]
const CHECKPOINT_CONTEXT_KEY = CHECKPOINT_SPAWN_CONTEXT_ENV_KEY
/** Set from the spawn option `browserContinuation` only (request environment cannot carry HAPPY_AUTOMATION_*). */
export const BROWSER_CONTINUATION_ENV = 'HAPPY_AUTOMATION_BROWSER_CONTINUATION'
type SessionScopedEnvironmentKey = SaycodeAgentEnvironmentKey | typeof CHECKPOINT_CONTEXT_KEY | 'HAPPY_PROJECT_SANDBOX_CONFIG' | typeof ADDITIONAL_DIRECTORIES_ENV | typeof BROWSER_CONTINUATION_ENV

export type SaycodeAgentEnvironment = Partial<Record<SessionScopedEnvironmentKey, string>>

function isLineageKey(key: string): boolean {
    return SESSION_LINEAGE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
}

/** Returns a copy of `env` without lineage variables (and without undefined values). */
export function scrubSessionLineageEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const scrubbed: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined || isLineageKey(key)) continue
        scrubbed[key] = value
    }
    return scrubbed
}

/** Builds one child environment after removing stale inherited lineage. */
export function buildSessionSpawnEnvironment(
    inherited: NodeJS.ProcessEnv,
    explicit: Record<string, string>,
): Record<string, string> {
    return {
        ...scrubSessionLineageEnv(inherited),
        ...explicit,
    }
}

/**
 * The Saycode agent capability is supplied per spawn, not inherited.
 *
 * A spawn request carries it in two legitimate cases: the client seeds a root
 * (depth 0) session, and `happy agent spawn` seeds a child (depth + 1) through
 * this same daemon RPC. Scrubbing it with the rest of the lineage left every
 * session without the capability while the orchestration prompt still told it
 * to use `happy agent` — 2026-09-13, `not_agent_env` everywhere.
 *
 * Only these keys, with values saycode-cli can actually use, pass through; a
 * grant that fails any check is dropped whole. A partial grant is worse than
 * none: SAYCODE_AGENT_ENV without a usable root fails isAgentEnv anyway, and a
 * rejected scope would silently shrink the tree the session can see.
 */
const DIRECTORY_VALUE = /^(\/|[A-Za-z]:[\\/]|\\\\)/
const COUNT_VALUE = /^\d{1,9}$/
const AGENT_ID_VALUE = /^[A-Za-z0-9_-]{1,64}$/

function readRequestedSaycodeAgentGrant(
    requested: Record<string, string>,
): SaycodeAgentEnvironment | undefined {
    if (requested.SAYCODE_AGENT_ENV !== '1') return undefined
    const isValid = (key: SaycodeAgentEnvironmentKey, pattern: RegExp): boolean => {
        const value = requested[key]
        return value === undefined || pattern.test(value.trim())
    }
    const root = requested.SAYCODE_AGENT_ROOT?.trim()
    if (!root || !DIRECTORY_VALUE.test(root)) return undefined
    if (!isValid('SAYCODE_AGENT_SCOPE', DIRECTORY_VALUE)) return undefined
    if (!isValid('SAYCODE_AGENT_DEPTH', COUNT_VALUE)) return undefined
    if (!isValid('SAYCODE_AGENT_MAX_SPAWN', COUNT_VALUE)) return undefined
    if (!isValid('SAYCODE_AGENT_ID', AGENT_ID_VALUE)) return undefined
    return Object.fromEntries(
        SAYCODE_AGENT_ENV_KEYS.flatMap((key) => requested[key] === undefined ? [] : [[key, requested[key]]]),
    )
}

/**
 * A spawn, resume or automation request supplies environment for the session, but the Happy process
 * itself runs with it first — before the claude UID switch and the sandbox. Variables that make that
 * process (node, the shells and git it runs) load code, change its paths or trust, or steer Happy's own
 * internals would run the requester's code as the daemon user, who holds the daemon token. Any company
 * member can send such a request, so these never come from one; ordinary project variables still do.
 */
const UNSAFE_REQUEST_ENV_KEYS = new Set([
    'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_REPL_EXTERNAL_MODULE',
    'NODE_ICU_DATA', 'NODE_PRESERVE_SYMLINKS', 'NODE_PRESERVE_SYMLINKS_MAIN',
    'PATH', 'HOME', 'SHELL', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'IFS', 'PROMPT_COMMAND', 'TMPDIR',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'SSH_ASKPASS', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
    // OpenSSL loads config, providers and engines (code) from these; bash runs startup options and traces.
    'OPENSSL_CONF', 'OPENSSL_MODULES', 'OPENSSL_ENGINES', 'SHELLOPTS', 'BASHOPTS', 'PS4',
])
const UNSAFE_REQUEST_ENV_PREFIXES = ['LD_', 'DYLD_', 'GIT_', 'HAPPY_', 'SAYCODE_', 'BASH_FUNC_']
/** Request values under the Happy/Saycode prefixes that are legitimately per-session (validated elsewhere). */
const REQUEST_ENV_ALLOWED_INTERNAL = new Set(['HAPPY_PROJECT_SANDBOX_CONFIG'])

function isUnsafeRequestKey(key: string): boolean {
    // Environment names are case-insensitive on Windows (Path, node_options): compare them upper-cased.
    const name = key.toUpperCase()
    // Commit identity only; every other GIT_* variable can point git at config, hooks or programs.
    if (REQUEST_ENV_ALLOWED_INTERNAL.has(name) || /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$/.test(name)) return false
    if (UNSAFE_REQUEST_ENV_KEYS.has(name) || name.endsWith('_PROXY')) return true
    return UNSAFE_REQUEST_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/** Returns a copy of request-supplied environment without the variables above. */
export function stripUnsafeRequestedEnvironment(requested: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(requested).filter(([key]) => !isUnsafeRequestKey(key)))
}

/**
 * The browser PoC harness points a session at its Runtime and grant file through the request. Only an
 * isolated PoC daemon started with HAPPY_BROWSER_POC_REQUEST_ENV=1 (its own environment, never a request;
 * the installer never sets it) admits these two.
 */
const POC_BROWSER_TASK_REQUEST_KEYS = ['HAPPY_BROWSER_TASK_RUNTIME_URL', 'HAPPY_BROWSER_TASK_GRANT_FILE'] as const

/** Keeps request-supplied project env from impersonating daemon-owned session state. */
export function buildSpawnRequestEnvironment(
    auth: Record<string, string>,
    requested: Record<string, string> | undefined,
    options: { allowPocBrowserTaskEnv?: boolean } = {},
): Record<string, string> {
    const poc = options.allowPocBrowserTaskEnv
        ? Object.fromEntries(POC_BROWSER_TASK_REQUEST_KEYS.flatMap((key) => requested?.[key] === undefined ? [] : [[key, requested[key]]]))
        : {}
    return {
        ...scrubSessionLineageEnv(stripUnsafeRequestedEnvironment(requested ?? {})),
        ...poc,
        // The agent grant is re-admitted only after its own validation (paths and counts).
        ...readRequestedSaycodeAgentGrant(requested ?? {}),
        ...auth,
    }
}

export function overlayManagedCredentialEnvironment(
    requested: Record<string, string>,
    managed: Record<string, string>,
): Record<string, string> {
    return { ...stripManagedCredentialConflicts(requested, managed), ...managed }
}

export function stripManagedCredentialConflicts(
    requested: Record<string, string>,
    managed: Record<string, string>,
): Record<string, string> {
    const effectiveRequested = { ...requested }
    for (const key of Object.keys(managed)) delete effectiveRequested[key]
    if (managed.ANTHROPIC_BASE_URL === 'https://api.z.ai/api/anthropic') {
        // ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL are in the shared list but
        // are set by the Z.AI lease itself, so the loop above already removed them.
        for (const key of CLAUDE_AUTH_OVERRIDE_ENV_KEYS) delete effectiveRequested[key]
        delete effectiveRequested.ANTHROPIC_MODEL
        delete effectiveRequested.ANTHROPIC_SMALL_FAST_MODEL
    }
    return effectiveRequested
}

export function buildManagedSessionSpawnEnvironment(
    inherited: NodeJS.ProcessEnv,
    explicit: Record<string, string>,
    managed: Record<string, string>,
): Record<string, string> {
    return overlayManagedCredentialEnvironment(
        buildSessionSpawnEnvironment(inherited, explicit),
        managed,
    )
}

/** Retains only the per-session Saycode capability needed by a later resume. */
export function captureSaycodeAgentEnvironment(
    env: NodeJS.ProcessEnv,
): SaycodeAgentEnvironment | undefined {
    const captured: SaycodeAgentEnvironment = {}
    if (env.SAYCODE_AGENT_ENV === '1' && env.SAYCODE_AGENT_ROOT?.trim()) {
        Object.assign(captured, Object.fromEntries(
            SAYCODE_AGENT_ENV_KEYS.flatMap((key) => env[key] === undefined ? [] : [[key, env[key]]]),
        ))
    }
    // Sandbox policy belongs to every session, including sessions without agent control.
    if (env.HAPPY_PROJECT_SANDBOX_CONFIG !== undefined) {
        captured.HAPPY_PROJECT_SANDBOX_CONFIG = env.HAPPY_PROJECT_SANDBOX_CONFIG
    }
    // Which sandbox roots were user-granted, so a resume can keep or replace exactly those.
    const additionalDirectories = env[ADDITIONAL_DIRECTORIES_ENV]
    if (additionalDirectories !== undefined && isValidAdditionalDirectories(additionalDirectories)) {
        captured[ADDITIONAL_DIRECTORIES_ENV] = additionalDirectories
    }
    // A Studio Chat(beta) session keeps being parked across the resumes an Agent Browser attention causes.
    if (env[BROWSER_CONTINUATION_ENV] === '1') captured[BROWSER_CONTINUATION_ENV] = '1'
    const encodedCheckpointContext = env[CHECKPOINT_CONTEXT_KEY]
    if (encodedCheckpointContext && readCheckpointSpawnContext(env)) {
        captured[CHECKPOINT_CONTEXT_KEY] = encodedCheckpointContext
    }
    return Object.keys(captured).length > 0 ? captured : undefined
}

function isValidAdditionalDirectories(value: string): boolean {
    try {
        readAdditionalDirectoriesEnvironment({ [ADDITIONAL_DIRECTORIES_ENV]: value })
        return true
    } catch {
        return false
    }
}

/** Restores one tracked session's capability without inheriting the caller's. */
export function buildResumedSessionSpawnEnvironment(input: {
    inherited: NodeJS.ProcessEnv
    explicit: Record<string, string>
    runtime?: Record<string, string>
    automation?: Record<string, string>
    agentEnvironment?: SaycodeAgentEnvironment
    sessionId: string
}): Record<string, string> {
    const policyKey = 'HAPPY_PROJECT_SANDBOX_CONFIG'
    // A session keeps its own policy; explicit updates still take precedence.
    const policy = input.explicit[policyKey] ?? input.automation?.[policyKey]
        ?? input.runtime?.[policyKey] ?? input.agentEnvironment?.[policyKey]
    return buildSessionSpawnEnvironment({ ...input.inherited, [policyKey]: undefined }, {
        // runtime (the resume request) and automation environments are request-supplied too.
        ...scrubSessionLineageEnv(stripUnsafeRequestedEnvironment(input.runtime ?? {})),
        ...scrubSessionLineageEnv(stripUnsafeRequestedEnvironment(input.automation ?? {})),
        ...input.explicit,
        ...(input.agentEnvironment ?? {}),
        ...(policy !== undefined ? { [policyKey]: policy } : {}),
        APLUS_SESSION_ID: input.sessionId,
    })
}

/**
 * Writes down which credential a **final** child environment actually spends.
 *
 * Applied to the finished environment on purpose. The managed credential is
 * overlaid last (`overlayManagedCredentialEnvironment`), so a decision taken
 * any earlier would record the credential the child never got to use.
 *
 * The value is the daemon's to decide because the child cannot: a managed
 * lease and a person's own key reach it as the same variables. What the daemon
 * cannot name is left `unknown` — never guessed. Writing an unestablished
 * source down as a personal subscription meters the run against somebody's own
 * plan.
 */
export function applyAppliedAiAuthSourceEnv(
    env: Record<string, string>,
    /**
     * The daemon applied the platform's leased GLM credential to this spawn —
     * `resolveManagedAiCredentialEnvironment` returned something. Only the
     * daemon can say this: a person's own GLM key reaches the child through the
     * same Z.AI variables, so the environment alone never proves ownership.
     */
    platformLeaseApplied = false,
): Record<string, string> {
    /*
     * The version is **written empty, not omitted**.
     *
     * tmux only applies the keys it is handed (`-e KEY=VALUE`); a key left out
     * stays in the tmux server environment and is inherited by the next child.
     * Deleting it from this object therefore clears it on a plain spawn and
     * leaves it standing on the tmux path, where an earlier session's version
     * would pair with this session's freshly written source. Writing it empty
     * overwrites on both paths, and `readAiAuthConnectionVersion` reads an
     * empty string as "no version" — only a managed run writes a real one
     * (`applyManagedAiAuthReporting`).
     */
    return {
        ...env,
        [HAPPY_AI_AUTH_SOURCE_ENV]: resolveAppliedAiAuthSource({ env, platformLeaseApplied }),
        [HAPPY_AI_AUTH_CONNECTION_VERSION_ENV]: '',
    }
}

/**
 * Sets or removes the confirmed-delivery switch on a **final** child
 * environment.
 *
 * Applied after the merge because the daemon's own environment is inherited
 * wholesale on the default path: deleting the key from the caller's extras is
 * not enough, since a value already present in `process.env` would survive the
 * merge and turn the switch on for a launch that never asked for it.
 *
 * The switch changes delivery behaviour only. It is not an identity and grants
 * no permission.
 */
export function applyConfirmedPromptDeliveryFlag(
    env: Record<string, string>,
    required: boolean,
): Record<string, string> {
    if (required) return { ...env, HAPPY_MANAGED_REQUIRE_PROMPT_ACK: '1' }
    const { HAPPY_MANAGED_REQUIRE_PROMPT_ACK: _removed, ...rest } = env
    return rest
}

/**
 * Which credential the requester explicitly chose for **one** BYOS spawn.
 *
 * Two kinds only, and the set is closed. A value outside it is rejected rather
 * than ignored: a silently dropped selection runs the session on whatever the
 * machine would have used anyway, which is the outcome the person was trying
 * to avoid by choosing.
 */
export const AI_AUTH_SELECTION_KINDS = ['machine-personal', 'org-bundle'] as const

export type AiAuthSelectionKind = (typeof AI_AUTH_SELECTION_KINDS)[number]

export type AiAuthSelection = { kind: AiAuthSelectionKind }

/**
 * Advertised in `MachineMetadataSchema` so a client can tell this daemon
 * understands the selection *before* sending one. `spawn-happy-session`
 * destructures its parameters, so an older daemon drops an unknown field
 * without a word — the version says which kinds the daemon knows, which the
 * mere presence of a field cannot.
 */
export const AI_AUTH_SELECTION_CAPABILITY = { version: 1 as const }

/** Rejects anything outside the closed set, following the spawn-parameter convention. */
export function parseAiAuthSelection(value: unknown): AiAuthSelection | undefined {
    if (value === undefined) return undefined
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('AI auth selection must be an object')
    }
    const kind = (value as { kind?: unknown }).kind
    if (typeof kind !== 'string' || !(AI_AUTH_SELECTION_KINDS as readonly string[]).includes(kind)) {
        throw new Error(
            `AI auth selection kind must be one of: ${AI_AUTH_SELECTION_KINDS.join(', ')}`,
        )
    }
    return { kind: kind as AiAuthSelectionKind }
}

/**
 * Whether the daemon still overlays its own managed credential on this spawn.
 *
 * `machine-personal` means "this machine's own login", so the daemon must not
 * put its managed credential on top — `overlayManagedCredentialEnvironment`
 * applies last and would otherwise always win. Without a selection nothing
 * changes.
 */
export function honorsManagedAiCredentials(selection: AiAuthSelection | undefined): boolean {
    return selection?.kind !== 'machine-personal'
}

/** A source the daemon applied itself — never the machine's own login. */
const DAEMON_APPLIED_AI_AUTH_SOURCES: readonly AiAuthSource[] = [
    'org-bundle',
    'platform-glm',
    'platform-gateway',
]

export type AiAuthSelectionVerdict = {
    /** What the finished environment says this spawn actually spends. */
    appliedSource: AiAuthSource
    /** Set when the spawn must not run; the text is shown to the requester. */
    rejection?: string
}

/**
 * Compares an explicit selection against what the daemon can **prove** about
 * the credential this spawn will spend.
 *
 * An earlier revision accepted `machine-personal` on a negative confirmation —
 * "the daemon overlaid nothing of its own". That reasoning was wrong, and
 * three things it cannot see prove it:
 *
 *  - an `ANTHROPIC_API_KEY` inherited from the daemon's own environment, or
 *    injected by the project, is somebody's credential and leaves the check
 *    untouched;
 *  - an organisation Claude bundle is installed by `cswap` into machine-global
 *    files and reaches no environment variable at all — worse, `cswap import`
 *    **removes every account not in the bundle**, so on such a machine the
 *    personal login the selection names does not exist any more;
 *  - a gateway token and base URL left by any earlier layer look the same.
 *
 * All three ran green against the old rule. "I added nothing" is not "the run
 * spends your own login": it is the absence of one kind of evidence, not the
 * presence of another. Passing it silently is the failure this feature exists
 * to prevent — a selected session metered against a credential the user did
 * not choose.
 *
 * So both kinds now require a **positive** statement that the daemon applied
 * the named credential. Today no code path produces one for either kind, so
 * every explicit selection is refused. That is the state of the evidence, not
 * a special case: when a path does write `HAPPY_AI_AUTH_SOURCE` from a proven
 * application, the same comparison starts passing with no change here.
 */
export function verifyAiAuthSelection(
    selection: AiAuthSelection | undefined,
    env: Record<string, string>,
): AiAuthSelectionVerdict {
    const appliedSource = normalizeAiAuthSource(env[HAPPY_AI_AUTH_SOURCE_ENV])
    if (selection === undefined) return { appliedSource }
    if (appliedSource === selectionAppliedSource(selection.kind)) return { appliedSource }
    return {
        appliedSource,
        rejection: `AI auth selection '${selection.kind}' was requested but this daemon could not`
            + ` confirm that credential for the spawn (applied source: '${appliedSource}').`
            + ` The session is not started with a substitute credential.`,
    }
}

/** The applied source that would prove a selection was honoured. */
function selectionAppliedSource(kind: AiAuthSelectionKind): AiAuthSource {
    return kind === 'org-bundle' ? 'org-bundle' : 'personal-subscription'
}
