/**
 * The startup a managed Cloud child performs instead of the ordinary one.
 *
 * The ordinary path authenticates an account, registers a machine and creates
 * a session. None of that is available here and none of it should be: the
 * parent already created the session, and this process holds only a bearer
 * scoped to it plus that session's raw key.
 *
 * The envelope arrives on an inherited descriptor whose number is the only
 * thing in the environment, and that variable is consumed on read — a
 * descriptor number left lying around is either closed or, later, reused for
 * something else entirely.
 */
import { CLAUDE_AUTH_OVERRIDE_ENV_KEYS } from '@/claude/utils/claudeAuthOverrideEnv';
import { logger } from '@/ui/logger';
import {
    findGatewayRoute,
    MANAGED_BOOTSTRAP_FD_ENV,
    readManagedSpawnEnvelopeFromFd,
    ManagedSpawnEnvelopeError,
    type ManagedSpawnEnvelope,
    type ManagedSpawnGateway,
} from '@/managed/managedSpawnBootstrap';
import {
    credentialKindForAiAuth,
    isPersonalAiAuth,
    MANAGED_AI_AUTH_MARKER_FILE,
    managedAiAuthConnectionDir,
    managedAiAuthProviderHome,
    type ManagedAiAuthPersonalKind,
    type ManagedAiAuthProvider,
} from '@/managed/managedAiAuth';
import { parseManagedAiAuthMarker, readManagedAiAuthApiKey } from '@/managed/managedAiAuthStore';
import {
    aiAuthSourceForManagedKind,
    HAPPY_AI_AUTH_CONNECTION_VERSION_ENV,
    HAPPY_AI_AUTH_SOURCE_ENV,
} from '@/usage/aiAuthSource';
import { buildZaiClaudeEnvironment } from '@/managed/zaiClaudeEnvironment';
import { attachManagedSession, ManagedAttachError, type ManagedAttachment } from '@/managed/managedSessionAttach';
import {
    MANAGED_CONTROL_CHILD_FD,
    managedStopAck,
    readManagedControlChannel,
} from '@/managed/managedControlChannel';
import { requestManagedGracefulStop } from '@/managed/managedGracefulStop';
import { readFileSync, writeSync } from 'node:fs';
import { Socket } from 'node:net';
import { MANAGED_PROJECT_ROOT } from '@/daemon/managedRuntimeIdentity';

export type ManagedStartup = {
    envelope: ManagedSpawnEnvelope;
    attachment: ManagedAttachment;
};

/**
 * Reads the managed envelope, if this process was given one, and attaches.
 *
 * Returns `null` for an ordinary spawn — the absence of the variable is the
 * whole signal, and nothing else in the environment can turn managed mode on.
 */
export async function readManagedStartup(
    env: NodeJS.ProcessEnv,
    now: number,
    /**
     * The server this runtime was configured for. The supervisor puts the
     * stored credential's origin here, and the attach refuses an envelope
     * naming any other one before it sends the scoped bearer anywhere.
     */
    configuredOrigin: string,
): Promise<ManagedStartup | null> {
    const raw = env[MANAGED_BOOTSTRAP_FD_ENV];
    if (raw === undefined) return null;
    // Consumed before anything can fail, so a retry cannot read a descriptor
    // that has since been closed and reassigned.
    delete env[MANAGED_BOOTSTRAP_FD_ENV];

    const fd = Number(raw);
    // `Number('')` is 0, which is a real descriptor; the text has to look like
    // a number before it is treated as one.
    if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(fd)) {
        throw new ManagedSpawnEnvelopeError('descriptor', 'must be a non-negative integer');
    }

    const envelope = await readManagedSpawnEnvelopeFromFd(fd, now);
    const attachment = await attachManagedSession(envelope.bootstrap, now, configuredOrigin);
    /*
     * The supervisor's only way to ask this run to end without killing it.
     *
     * Opened here because it has to be listening before the message loop
     * exists — a stop asked for during startup is remembered by
     * `requestManagedGracefulStop` and applied when the loop registers.
     *
     * A supervisor that does not provide the slot leaves the descriptor
     * closed, and this run simply cannot be stopped gracefully. That is
     * fail-closed on its own: with no end of input, the quiescence gate
     * refuses `eof-unverified` and no checkpoint archives provider state.
     */
    openManagedControlChannel();
    return { envelope, attachment };
}

/**
 * The offline branch, for a managed run.
 *
 * An unreachable server means this run cannot proceed. The ordinary path
 * answers by creating a fresh session once the server returns, which for a
 * managed run would produce a session sealed with a key the parent never saw —
 * the work would run and its output would be unreadable to everyone waiting
 * for it.
 */
export function resolveManagedOfflineFallback(managed: boolean): void {
    if (managed) {
        throw new ManagedAttachError('a managed run cannot start a new session while the server is unavailable');
    }
}


/**
 * The account bearer, for work that only an account can do.
 *
 * A managed run reaches this only through a path that should have been
 * branched away above it, so the refusal is a bug report, not a fallback.
 */
export function requireAccountMachineId(machineId: string | undefined): string {
    if (machineId === undefined) {
        throw new Error('this operation needs a registered machine; a managed run has none');
    }
    return machineId;
}

export function requireAccountToken(token: string | null): string {
    if (token === null) {
        throw new Error('this operation needs an account token; a managed run has none');
    }
    return token;
}

/**
 * Publishes the envelope's prompt and effort through the seam the agents
 * already consume.
 *
 * The daemon delivers a scheduled prompt, model and effort through
 * `HAPPY_INITIAL_*`, read exactly once by the agent startup. A managed run has
 * the same three values, verified, so it uses the same seam rather than a
 * second one that would have to be kept in step with it. The values are
 * written over anything inherited: an inherited prompt belongs to some other
 * launch.
 */
export function applyManagedInitialPrompt(
    env: NodeJS.ProcessEnv,
    envelope: ManagedSpawnEnvelope,
): void {
    env.HAPPY_INITIAL_PROMPT = envelope.initialPrompt;
    env.HAPPY_INITIAL_PROMPT_LOCAL_ID = envelope.initialPromptLocalId;
    env.HAPPY_INITIAL_MODEL = envelope.model;
    env.HAPPY_INITIAL_EFFORT = envelope.effort;
    // Confirmed delivery is part of what a managed envelope *is*, not something
    // a caller switches on. The prompt is consumed a few lines into the runner
    // and the provider is reached shortly after; without this the run answers
    // the prompt and spends its capability before anything durable records the
    // delivery, and a failure after that cannot be told from one before it.
    env.HAPPY_MANAGED_REQUIRE_PROMPT_ACK = '1';
    // A file-staged prompt from another launch would win over the value above.
    delete env.HAPPY_INITIAL_PROMPT_FILE;
}

/**
 * Drops `--model`/`-m` from caller arguments.
 *
 * The agent CLI takes a model on its own command line, and it wins over the
 * one this process selected. For a managed run that is a caller choosing a
 * model the run was not priced for.
 */
export function stripAgentModelArguments(args: string[] | undefined): string[] | undefined {
    if (!args) return args;
    const kept: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--model' || arg === '-m') {
            i++;
            continue;
        }
        if (arg.startsWith('--model=')) continue;
        kept.push(arg);
    }
    return kept;
}

/**
 * Every provider credential an agent CLI will pick up on its own.
 *
 * Listed so they can be removed. An agent that finds one of these in its
 * environment uses it instead of the gateway, which means a managed run
 * billing somebody else's key and sending the run's content to a provider the
 * approval never covered.
 */
const PROVIDER_CREDENTIAL_ENV: readonly string[] = [
    ...CLAUDE_AUTH_OVERRIDE_ENV_KEYS,
    'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT',
    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY',
];

/**
 * Where an agent CLI reads a login from, rather than a credential itself.
 *
 * Same consequence, different kind of value, so it is a separate list: a
 * `CLAUDE_CONFIG_DIR` inherited from anywhere points this run at somebody
 * else's login, and on a managed runtime "somebody else" is another user's
 * personal subscription under `/workspace/.auth`. Cleared on every managed
 * launch and set again only for the connection this run was admitted on.
 */
const PROVIDER_AUTH_HOME_ENV = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'];

/**
 * What this run tells the usage ledger it spent.
 *
 * A prefix rather than the two keys, for the reason the lineage list gives:
 * the family is added to over time and a list is a list that will be short by
 * one. A caller that sets any of it is a caller choosing which account the run
 * is metered against — the envelope decided that, and an override applied
 * after startup would replace it.
 */
const AI_AUTH_REPORTING_ENV_PREFIX = 'HAPPY_AI_AUTH_';

/**
 * Drops provider credentials from a caller-supplied environment overlay.
 *
 * `--claude-env` values are written into `process.env` after startup
 * (`claudeRemote.ts`), so they win over anything decided here. For a managed
 * run that is a caller redirecting the gateway or substituting a key after the
 * approval was made.
 */
export function stripProviderCredentialOverrides(
    overrides: Record<string, string> | undefined,
): Record<string, string> | undefined {
    if (!overrides) return overrides;
    const kept: Record<string, string> = {};
    for (const [key, value] of Object.entries(overrides)) {
        const canonicalKey = key.toUpperCase();
        if (PROVIDER_CREDENTIAL_ENV.includes(canonicalKey)) continue;
        // An override naming an auth home is the same substitution by another
        // route: it would point this run at a login it was not admitted on.
        if (PROVIDER_AUTH_HOME_ENV.includes(canonicalKey)) continue;
        // Not a credential, but the same substitution one layer over: it names
        // whose credential this run is billed to.
        if (canonicalKey.startsWith(AI_AUTH_REPORTING_ENV_PREFIX)) continue;
        kept[key] = value;
    }
    return kept;
}

/**
 * Prefixes naming a session some earlier launch on this runtime was attached
 * to, forked from, or asked to backfill.
 *
 * Prefixes rather than a list of keys, deliberately. The keys under them are
 * added to over time — reconnect alone carries an id, a key, a variant, a
 * snapshot and three versions, and the fork family names both a Claude session
 * and a Codex thread — and a list is a list that will be short by one. The
 * daemon scrubs the same prefixes when it spawns; this is the child doing it
 * for itself, because the environment it starts in is not always one the
 * daemon just built.
 *
 * `HAPPY_INITIAL_` is deliberately absent: those values are this run's own,
 * and are written immediately after this runs.
 */
const FOREIGN_SESSION_LINEAGE_PREFIXES = [
    'HAPPY_RECONNECT_',
    // Covers both `HAPPY_FORK_*` (the native session or thread to resume and
    // backfill from) and `HAPPY_FORKED_FROM_*` (the lineage recorded in
    // metadata).
    'HAPPY_FORK',
    'HAPPY_CREATED_BY',
    'HAPPY_DEFERRED_CONTINUATION_',
];

/**
 * Forgets any session this runtime was previously attached to.
 *
 * A reused runtime can still carry an earlier launch's lineage. The runners
 * read it before anything else and act on it: a reconnect id resumes that
 * session, dropping this run's prompt as already delivered and merging the
 * foreign snapshot's metadata; a fork id reads that session's transcript off
 * disk and replays it into *this* session, then rewrites the native session id
 * to match. The result is a managed run showing somebody else's conversation
 * under its own SID.
 *
 * Cleared rather than ignored at each call site: the values reach several
 * readers across two runners, and one missed reader is the whole defect again.
 */
export function clearForeignSessionLineage(env: NodeJS.ProcessEnv): void {
    for (const key of Object.keys(env)) {
        if (FOREIGN_SESSION_LINEAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
            delete env[key];
        }
    }
}

/**
 * Points the agent at the one provider route this run was admitted on.
 *
 * Two routes, and they are exclusive. On a platform kind the capability is the
 * only credential this run may spend: it was minted for this run, on this
 * model, against this endpoint. On a personal subscription there is no
 * capability at all — the provider CLI talks to the vendor with the login the
 * requester put in this runtime's auth home, and the only thing this sets is
 * where that home is.
 *
 * Every inherited provider credential **and** every inherited auth home is
 * cleared first, on both branches. An inherited value is not a fallback here:
 * a key is a way to run outside the approval, and a config directory is a way
 * to run on another user's subscription.
 */
export function applyManagedGatewayEnvironment(
    env: NodeJS.ProcessEnv,
    envelope: ManagedSpawnEnvelope,
    /**
     * How the key file is read, for a `personal-api-key` run.
     *
     * A parameter because this function is otherwise pure and the file it needs
     * exists only on a real runtime, under a uid only that runtime has. It
     * throws on a missing file, like `readFileSync`; the reader turns that into
     * "no key", and no key is a refusal.
     */
    readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): void {
    for (const key of PROVIDER_CREDENTIAL_ENV) delete env[key];
    for (const key of PROVIDER_AUTH_HOME_ENV) delete env[key];
    applyManagedAiAuthReporting(env, envelope.aiAuth);
    if (envelope.aiAuth.kind === 'personal-subscription') {
        assertAdmittedConnection(envelope.aiAuth, readFile);
        /*
         * Claude reads its login from `CLAUDE_CONFIG_DIR`, so it is set here.
         *
         * Codex reads `CODEX_HOME`, and that one is **not** set here: the
         * launcher plan owns it (`codexToolPolicy` refuses a provider
         * environment that carries `CODEX_HOME` and then sets it from the
         * plan's `codexHome`), so setting it here would refuse every managed
         * codex launch rather than configure one.
         */
        if (envelope.agent === 'claude') {
            env.CLAUDE_CONFIG_DIR = managedAiAuthProviderHome(
                envelope.aiAuth.connectionId, 'claude',
            );
        }
        return;
    }
    if (envelope.aiAuth.kind === 'personal-api-key') {
        applyPersonalApiKeyEnvironment(env, envelope.aiAuth, readFile);
        return;
    }
    const gateway = requireManagedGateway(envelope);
    const base = managedGatewayClientBaseUrl(envelope);
    if (envelope.agent === 'claude') {
        env.ANTHROPIC_BASE_URL = base;
        env.ANTHROPIC_AUTH_TOKEN = gateway.capability;
        return;
    }
    env.OPENAI_BASE_URL = base;
    env.OPENAI_API_KEY = gateway.capability;
}

/**
 * Records which credential this run is actually spending.
 *
 * Written here, beside the branch that builds the credential environment,
 * because this is the only place that holds both the envelope and the
 * environment the agent inherits — and `applyManagedGatewayEnvironment` is
 * what both runners call. Deriving it at the two call sites instead would put
 * the same mapping in two files and leave it to drift from the branches below.
 *
 * `aiAuth.kind` is the authority. Nothing in the environment may overturn it:
 * the gateway base URL differs per envelope, and an organisation bundle and a
 * person's own key are the same variable. Written unconditionally, so an
 * inherited value from an earlier launch on a reused runtime is replaced
 * rather than believed.
 *
 * The connection version is written only when the envelope carries one —
 * `ManagedAiAuthSelection` has it on the personal kinds alone. A platform kind
 * has no connection, and a made-up version reports an admission that never
 * happened. Deleted otherwise, for the same reason the source is overwritten.
 */
function applyManagedAiAuthReporting(
    env: NodeJS.ProcessEnv,
    aiAuth: ManagedSpawnEnvelope['aiAuth'],
): void {
    env[HAPPY_AI_AUTH_SOURCE_ENV] = aiAuthSourceForManagedKind(aiAuth.kind);
    if (isPersonalAiAuth(aiAuth)) {
        env[HAPPY_AI_AUTH_CONNECTION_VERSION_ENV] = String(aiAuth.connectionVersion);
        return;
    }
    delete env[HAPPY_AI_AUTH_CONNECTION_VERSION_ENV];
}

/**
 * The home still holds the login this run was admitted on.
 *
 * The spawn gate compared the marker with the selection when the run was
 * admitted; this is the same comparison where the environment is built. The
 * home is keyed by connection id alone, so between the two a logout and a new
 * login on the same connection put another account's credential under the
 * same path — and a run started on it would spend a login it was never
 * admitted on (R24). A marker that is gone, unreadable, or names another
 * version, provider or credential kind is that substitution, or its trace.
 */
function assertAdmittedConnection(
    aiAuth: {
        kind: ManagedAiAuthPersonalKind;
        provider: ManagedAiAuthProvider;
        connectionId: string;
        connectionVersion: number;
    },
    readFile: (path: string) => string,
): void {
    let raw: string;
    try {
        raw = readFile(`${managedAiAuthConnectionDir(aiAuth.connectionId)}/${MANAGED_AI_AUTH_MARKER_FILE}`);
    } catch {
        throw new ManagedAttachError('personal auth home is not the connection this run was admitted on');
    }
    const marker = parseManagedAiAuthMarker(raw);
    const admitted = marker !== null
        && marker.provider === aiAuth.provider
        && marker.connectionVersion === aiAuth.connectionVersion
        && marker.credentialKind === credentialKindForAiAuth(aiAuth.kind);
    if (!admitted) {
        throw new ManagedAttachError('personal auth home is not the connection this run was admitted on');
    }
}

/**
 * Points the agent at the key this connection registered.
 *
 * The key is read here rather than carried in the envelope: the envelope is
 * built by the parent and crosses a socket, and a key in it would be a key in
 * the parent's memory, its logs and its database. What the parent sends is the
 * connection it was admitted on; the runtime holds the secret.
 *
 * A key that is not there is the end of the run. There is no fallback that is
 * not a substitution — the gateway would spend Studio's budget on a run priced
 * as the user's own, and an inherited variable is whatever the last launch
 * left behind.
 */
function applyPersonalApiKeyEnvironment(
    env: NodeJS.ProcessEnv,
    aiAuth: {
        kind: ManagedAiAuthPersonalKind;
        provider: ManagedAiAuthProvider;
        connectionId: string;
        connectionVersion: number;
    },
    readFile: (path: string) => string,
): void {
    const home = managedAiAuthProviderHome(aiAuth.connectionId, aiAuth.provider);
    const apiKey = readManagedAiAuthApiKey(home, (path) => readFile(path));
    if (apiKey === null) throw new ManagedAttachError('personal api key is not present');
    // After the key, on purpose: the store writes the marker last, so a marker
    // that still matches after the key was read is a key that was the
    // admitted one when it was read.
    assertAdmittedConnection(aiAuth, readFile);
    if (aiAuth.provider === 'codex') {
        // `CODEX_HOME` stays the launcher plan's, exactly as on a personal
        // subscription: `codexToolPolicy` refuses a provider environment that
        // carries it.
        env.OPENAI_API_KEY = apiKey;
        return;
    }
    /*
     * Both remaining providers are spent by Claude Code, so both get a config
     * directory of their own — the agent writes state beside its credential,
     * and two connections sharing one directory is two users sharing it.
     */
    env.CLAUDE_CONFIG_DIR = home;
    if (aiAuth.provider === 'glm') {
        // A GLM key is an Anthropic-wire key against Z.AI, which takes the
        // whole route and the model mapping, not just a token.
        Object.assign(env, buildZaiClaudeEnvironment(apiKey));
        return;
    }
    env.ANTHROPIC_API_KEY = apiKey;
}

/**
 * The envelope's gateway, for a path that cannot run without one.
 *
 * The parser already refuses a platform envelope with no gateway, so reaching
 * this with `null` means a personal run took a gateway path. That is a bug in
 * the branch above it, not a run to continue with a substitute.
 */
function requireManagedGateway(envelope: ManagedSpawnEnvelope): ManagedSpawnGateway {
    if (envelope.gateway === null) {
        throw new ManagedAttachError('this run has no gateway; it was admitted on a personal subscription');
    }
    return envelope.gateway;
}

/** The provider id this run's configuration is registered under. */
export const MANAGED_CODEX_PROVIDER_ID = 'saycode-managed';

/**
 * The base URL to hand a client, derived from the approved route.
 *
 * The envelope carries the whole route because that is what the parent signed
 * and prices. Each client appends its own suffix to whatever base it is given,
 * so the base is the route minus that suffix — computed from the approved row
 * rather than by trimming the string, and checked against the route so a
 * mismatch is a refusal instead of a quietly different address.
 */
export function managedGatewayClientBaseUrl(envelope: ManagedSpawnEnvelope): string {
    const gateway = requireManagedGateway(envelope);
    // By agent **and** provider: claude has two approved upstreams — Anthropic
    // and the GLM route the default experience runs on — and a lookup by agent
    // alone would hand a GLM run the Anthropic base URL.
    const route = findGatewayRoute(envelope.agent, gateway.provider);
    if (!route) throw new ManagedAttachError('no gateway route for this agent and provider');
    const url = new URL(gateway.baseUrl);
    if (url.pathname !== route.path) {
        throw new ManagedAttachError('the gateway route is not the one this agent was approved for');
    }
    return `${url.origin}${route.clientBasePath}`;
}

/** Named for the SDK it configures, so call sites read as what they set. */
export function managedClaudeGatewayBaseUrl(envelope: ManagedSpawnEnvelope): string {
    return managedGatewayClientBaseUrl(envelope);
}

/**
 * The whole provider configuration the Codex CLI is started with.
 *
 * Passed as command-line configuration rather than left to the user's config
 * file: `model_provider` there selects which of the on-disk providers is used,
 * and an on-disk provider is somebody else's account. Every axis the CLI would
 * otherwise read — base URL, which environment variable holds the key, the
 * wire protocol, whether OpenAI auth is required — is pinned here.
 */
export function managedCodexProviderArguments(envelope: ManagedSpawnEnvelope): string[] {
    /*
     * **Empty for either personal kind.** There is no gateway to point at, and
     * pinning `model_provider` would take the run off the default OpenAI
     * provider — the one the requester's own `codex login` authenticates
     * against, and the one that reads `OPENAI_API_KEY` when the connection
     * holds a key instead. The tool-boundary arguments are a separate list and
     * still apply — `resolveManagedCodexArguments` appends the verified plan to
     * whatever this returns, and still refuses a managed run that has no plan.
     */
    if (isPersonalAiAuth(envelope.aiAuth)) return [];
    const base = managedGatewayClientBaseUrl(envelope);
    const provider = `model_providers.${MANAGED_CODEX_PROVIDER_ID}`;
    return [
        '-c', `${provider}.name="Saycode managed gateway"`,
        '-c', `${provider}.base_url="${base}"`,
        '-c', `${provider}.env_key="OPENAI_API_KEY"`,
        '-c', `${provider}.requires_openai_auth=false`,
        '-c', `${provider}.wire_api="responses"`,
        '-c', `model_provider="${MANAGED_CODEX_PROVIDER_ID}"`,
    ];
}

/**
 * Requires the process to actually be standing in the runtime's project root.
 *
 * Rewriting `metadata.path` only changes what is displayed. The agent reads and
 * writes relative to the real working directory, so a managed run that started
 * somewhere else would edit files outside the workspace it was granted while
 * reporting that it was inside it.
 */
export function assertManagedWorkingDirectory(cwd: string): void {
    if (cwd !== MANAGED_PROJECT_ROOT) {
        throw new ManagedAttachError('a managed run must start in the runtime project root');
    }
}

/**
 * Which filesystem settings sources a session may load.
 *
 * `undefined` is not "none" — it is the SDK's default, which loads every source
 * Claude Code would, including `~/.claude/settings.json`. A settings file's
 * `env` block is applied to the agent and wins over the environment this
 * startup produced, so for a managed run "none" has to be said explicitly.
 */
export function managedSettingSources<T>(
    lockdown: boolean | undefined,
    configured: T[] | undefined,
): T[] | undefined {
    return lockdown ? ([] as T[]) : configured;
}

/**
 * Starts reading the control channel, if this runtime gave the child one.
 *
 * Exported for the test that proves a missing slot is survivable rather than
 * fatal; production calls it from `readManagedStartup`.
 */
export function openManagedControlChannel(deps: {
    open?: (fd: number) => Parameters<typeof readManagedControlChannel>[0]['source'];
    onUnusable?: () => void;
} = {}): (() => void) | null {
    const open = deps.open ?? ((fd: number) => {
        /*
         * A socket, and **unref'd**.
         *
         * The extra stdio slot is a socketpair, so this end is a socket rather
         * than a file. That matters twice over:
         *
         *  - `fs.createReadStream` keeps a read pending on the threadpool, and
         *    a pending read holds the event loop open. The run then finishes
         *    all its work, reports its verdict, and **never exits** — which
         *    the supervisor sees as `exit-unobserved` and the gate turns into
         *    a refusal. Measured: a provider alive 44s after its last log
         *    line, with the whole checkpoint waiting on an exit it was itself
         *    preventing.
         *  - `unref()` says this listener is not a reason to stay alive. It
         *    still delivers a stop while the run has work; it simply stops
         *    outliving it.
         */
        const socket = new Socket({ fd, readable: true, writable: false });
        socket.unref();
        return socket;
    });
    try {
        return readManagedControlChannel({
            source: open(MANAGED_CONTROL_CHILD_FD),
            onStop: requestManagedGracefulStop,
            /*
             * The failure that actually happens. A descriptor this runtime
             * never opened constructs a stream fine and emits `error` on the
             * first read — asynchronously, long after this `try` has returned.
             * Unhandled, that is a fatal `error` event on the child.
             */
            onUnusable: deps.onUnusable,
        });
    } catch {
        // Synchronous construction failed instead. Same conclusion: no
        // channel, so nothing can end this run's input and the quiescence gate
        // refuses `eof-unverified`. Not fatal, and not silently fine.
        deps.onUnusable?.();
        return null;
    }
}

/**
 * Tells the supervisor how this managed run ended, on the control descriptor.
 *
 * Written with `writeSync` rather than through a stream: this is the last
 * thing the run does, and a buffered write would race the process leaving.
 *
 * A run with no channel simply cannot answer. That is not a failure to report
 * — nothing asked it to stop — and the supervisor's own budget covers it.
 */
export function reportManagedStopOutcome(verdict: string, deps: {
    write?: (fd: number, text: string) => void;
    /**
     * The native session this generation wrote, when it had one.
     *
     * Travels in the same frame as the verdict so the supervisor reads one
     * observation rather than two it would have to pair up itself.
     */
    nativeId?: string | null;
} = {}): boolean {
    const write = deps.write ?? ((fd, text) => { writeSync(fd, text); });
    /*
     * The one thing that crosses this boundary, and until now it was invisible
     * on both sides: the supervisor logs what it did with the verdict, never
     * what the verdict was, and the child logged nothing at all. A refusal's
     * cause then has to be deduced, and deduction is what kept being wrong.
     *
     * A closed code — the same vocabulary the channel carries.
     */
    logger.debug(`[managed] stop verdict ${/^[a-z-]{1,40}$/.test(verdict) ? verdict : 'unknown'}`);
    try {
        write(MANAGED_CONTROL_CHILD_FD, managedStopAck(verdict, deps.nativeId));
        return true;
    } catch {
        // The channel is gone. Saying nothing is correct: the supervisor
        // requires an ack it never received to be absent, not assumed.
        return false;
    }
}
