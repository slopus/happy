/**
 * Builds the lesson host a provider process uses for its own session.
 *
 * The daemon and the provider run in different processes, so the daemon's
 * supervisor is not reachable from a turn loop. This builds an equivalent one
 * here, and it is allowed to because everything it needs is already trusted in
 * this process:
 *
 *  - the **project id** comes from `HAPPY_CHECKPOINT_SPAWN_CONTEXT`, which the
 *    daemon writes and strips from caller-supplied environment, and which it
 *    only writes when it had an authoritative project binding;
 *  - the **workspace** is never taken from `cwd` or from that context. It is
 *    requested from the studio, which signs the project's own directory;
 *  - shared-machine sessions combine their machine account bearer with the
 *    daemon-verified caller grant and registered session. Studio resolves the
 *    actual caller; a managed run without an account credential is unsupported.
 *
 * Every absence returns `null`. A session without a lesson host runs exactly
 * as it did before this existed.
 */
import { resolve } from 'node:path';
import packageJson from '../../package.json';

import type { SessionEnvelope } from '@slopus/happy-wire';

import { logger } from '@/ui/logger';
import { refreshMcpCallerGrantIfExpiring } from '@/aplus/refreshMcpCallerGrant';
import { readLessonOwner } from './lessonOwnerMarker';
import { readCheckpointSpawnContext } from '@/checkpoint/checkpointSpawnContext';

import { createLessonHostSupervisor } from './lessonHostSupervisor';
import {
    createLessonGrantVerifier,
    lessonGrantAudience,
} from './lessonGrantVerifier';
import {
    fetchLessonGrantPublicKey,
    requestLessonSnapshotGrant,
    type LessonHostRuntime,
} from './lessonHostRuntime';
import { createLessonTurnHost, type LessonTurnHost } from './lessonTurnHost';
import { createLessonReviewWorker, lessonCandidateEnvelope, type LessonReviewWorker } from './lessonReviewWorker';
import { LessonReviewBudget } from './lessonReviewBudget';
import {
    createLessonReviewOutcomeStore,
    createLessonSettingsStore,
    lessonReviewLedgerPath,
    lessonReviewOutcomePath,
    lessonSettingsPath,
} from './lessonSettingsStore';
import type { LessonTurnKind } from './lessonTurnEvidence';

// Captured in this process, never read from a newly installed package on disk.
// This cohort is not a claim that the daemon or loaded CML has the same version.
const processStartedAt = new Date(Date.now() - process.uptime() * 1_000).toISOString();
type BootstrapOutcome = 'start' | 'missing_account' | 'missing_machine' | 'missing_origin'
    | 'missing_project' | 'missing_state_root' | 'owner_not_host' | 'public_key_unavailable'
    | 'invalid_public_key' | 'snapshot_grant_unavailable' | 'runtime_unavailable'
    | 'grant_rejected' | 'runtime_incomplete' | 'caller_unavailable' | 'ready' | 'timeout' | 'exception' | 'late_closed';
function reportBootstrap(outcome: BootstrapOutcome, phase: 'bootstrap' | 'readiness' = 'bootstrap'): null {
    logger.debug(`[lesson-host] phase=${phase} outcome=${outcome}`, {
        cliVersion: packageJson.version, processStartedAt,
    });
    return null;
}

/**
 * How long the whole bootstrap may take.
 *
 * Building this host makes three network calls — the verification key, the
 * snapshot grant, the store open. None of them is on the recall budget, so a
 * slow or unreachable studio would hold the first turn open for as long as the
 * socket took. The deadline bounds the whole sequence and a session that
 * misses it simply runs without lessons.
 */
export const LESSON_SESSION_BOOTSTRAP_BUDGET_MS = 3_000;

/**
 * How long a lease refresh may take on a turn's path.
 *
 * Short: it sits inside the recall budget, and a slow answer means this turn
 * runs without lessons rather than waits.
 */
export const LESSON_AUTHORIZE_BUDGET_MS = 500;

export interface LessonSessionHost {
    turn: LessonTurnHost | null;
    review: LessonReviewWorker | null;
    /**
     * What kind of session this is, decided from the daemon's own markers.
     *
     * The turn loop does not guess per message: an automation run is marked
     * when the daemon spawns it, and that mark is what keeps automation and
     * review turns from teaching the project.
     */
    sessionKind: LessonTurnKind;
    close(): Promise<void>;
}

/**
 * Reads the session kind from the environment the daemon wrote.
 *
 * `HAPPY_AUTOMATION_RUN_ONCE` and `HAPPY_AUTOMATION_RESUME_PROMPT` are set by
 * the daemon for automation runs; both are consumed by the runner before any
 * agent code executes, so this is read at construction while they are still
 * present. Absence means an ordinary session — the same reading the rest of
 * the runner already makes.
 */
/**
 * The state root the daemon uses for this machine.
 *
 * Written by the daemon into every session's environment so a provider can
 * tell whether it shares the daemon's root. Read-only here; a provider that
 * disagrees with it does not get to pick.
 */
export const LESSON_DAEMON_HOME_ENV = 'HAPPY_LESSON_DAEMON_HOME';

/**
 * The state root this session's lesson settings and ledger come from.
 *
 * Not the provider's own `HAPPY_HOME_DIR`. The daemon relocates that per
 * session for a collaborator's credentials, and both the settings file and the
 * spending ledger must be the machine's, not the session's: a private settings
 * file would miss the UI's "recall off" and default back to on, and a private
 * ledger would make the machine-wide budget stop bounding anything.
 *
 * So the daemon states its own root and every session uses it. This is a
 * *state* location only — the credential, the signed actor and the permissions
 * are unaffected, and a collaborator's session still acts as that
 * collaborator.
 *
 * `null` when the daemon said nothing. That is an old daemon or a runner
 * started outside one, and it is reported as unsupported rather than guessed:
 * a guess here silently re-enables recall for a user who turned it off.
 */
export function lessonStateRoot(env: NodeJS.ProcessEnv): string | null {
    const daemonHome = env[LESSON_DAEMON_HOME_ENV]?.trim();
    return daemonHome ? resolve(daemonHome) : null;
}

export function readLessonSessionKind(env: NodeJS.ProcessEnv): LessonTurnKind {
    return env.HAPPY_AUTOMATION_RUN_ONCE || env.HAPPY_AUTOMATION_RESUME_PROMPT === '1'
        ? 'automation'
        : 'foreground';
}

/** Reads the studio origin the daemon configured. Never a request value. */
function studioOrigin(env: NodeJS.ProcessEnv): string | null {
    const configured = env.HAPPY_APLUS_MCP_CONFIG_URL;
    if (!configured) return null;
    try {
        return new URL(configured).origin;
    } catch {
        return null;
    }
}

/** Starts in the background; only the first cold recall may wait, for at most
 * one readiness budget per session. Late startup remains reusable by later
 * turns, and shutdown never awaits it.
 */
export function createLazyLessonSessionHost(
    input: Parameters<typeof createLessonSessionHost>[0] & {
        /**
         * The bootstrap to run, for tests that need to decide when — and
         * whether — it lands. Production passes nothing.
         */
        bootstrap?: () => Promise<LessonSessionHost | null>;
    },
): LessonSessionHost {
    let ready: LessonSessionHost | null = null;
    let disposed = false;
    let starting = false;
    let retryAt = 0;
    let pending: Promise<void> | undefined;
    // A hung studio must not cost every turn a budget; later turns see only a ready host.
    let readinessBudgetSpent = false;
    const shutdown = new AbortController();
    const start = (eager = false) => {
        if (disposed || ready || starting || Date.now() < retryAt) return;
        starting = true;
        // Failure is retried only by later turns, never a background timer.
        pending = (async () => {
            try {
                const built = await (input.bootstrap ?? (() => bootstrapLessonSessionHost(input)))();
                if (built && disposed) {
                    await built.close().catch(() => undefined);
                    reportBootstrap('late_closed');
                } else if (!disposed) {
                    ready = built;
                }
            } catch {
                reportBootstrap('exception');
                // A transient network failure must not disable this session forever.
            } finally {
                /*
                 * The spawn-time attempt runs before Desktop binds the session to
                 * its project, so the studio routinely refuses it. The first
                 * message arrives a few seconds later; backing off here would
                 * skip recall on exactly that turn.
                 */
                retryAt = eager ? 0 : Date.now() + 5_000;
                starting = false;
            }
        })();
    };
    start(true);

    const settled = () => {
        if (disposed) return null;
        start();
        return ready;
    };
    const awaitReady = async (signal?: AbortSignal) => {
        if (signal?.aborted || disposed) return null;
        const current = settled();
        if (current || !starting || !pending || readinessBudgetSpent) return current;
        readinessBudgetSpent = true;
        const cancelled = AbortSignal.any([shutdown.signal, ...(signal ? [signal] : [])]);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: () => void = () => undefined;
        try {
            await Promise.race([pending, new Promise<void>(resolve => {
                onAbort = resolve;
                cancelled.addEventListener('abort', onAbort, { once: true });
                timer = setTimeout(resolve, input.budgetMs ?? 1_000);
                if (cancelled.aborted) resolve();
            })]);
        } finally {
            clearTimeout(timer);
            cancelled.removeEventListener('abort', onAbort);
        }
        if (cancelled.aborted) return null;
        if (!ready && starting) reportBootstrap('timeout', 'readiness');
        return ready;
    };

    return {
        // Read once at construction from the same environment; it does not
        // depend on the network and must not wait for it.
        sessionKind: readLessonSessionKind(input.env ?? process.env),
        turn: {
            async recall(args) {
                const host = (await awaitReady(args.signal))?.turn;
                if (disposed || args.signal?.aborted) return { outcome: 'unsupported' as const };
                return host ? host.recall(args) : { outcome: starting && !disposed ? 'timeout' as const : 'unsupported' as const };
            },
            async acknowledge(ticket) {
                const host = ready?.turn;
                return host ? host.acknowledge(ticket) : false;
            },
        },
        review: {
            async prepareReviewTurn() {
                // Recall already waited for readiness this turn; never wait twice.
                const host = settled();
                if (!host) return null;
                const prepared = await host.review?.prepareReviewTurn?.();
                return disposed ? null : prepared ?? null;
            },
            async reviewFinishedTurn(args) {
                const host = settled()?.review;
                return host ? host.reviewFinishedTurn(args) : 'unsupported';
            },
        },
        async close() {
            /*
             * Closing must not wait on the bootstrap.
             *
             * This runs on the provider's exit path, and the thing being
             * awaited is a studio that may be exactly why the host never
             * became ready — awaiting it would hold shutdown open for as long
             * as that call takes. Setting `disposed` first is what makes the
             * wait unnecessary: whatever the bootstrap produces afterwards
             * sees it and closes itself in the bootstrap above.
             */
            disposed = true;
            shutdown.abort();
            const built = ready;
            ready = null;
            await built?.close().catch(() => undefined);
        },
    };
}

export async function createLessonSessionHost(input: {
    /** null for a managed run, which holds no account credential. */
    accountToken: string | null;
    machineId: string | null;
    sessionId: string;
    happyHomeDir: string;
    env?: NodeJS.ProcessEnv;
    budgetMs?: number;
    /** Sends a stored candidate to this session's transcript for inline approval. */
    announceCandidate?: (envelope: SessionEnvelope) => void;
}): Promise<LessonSessionHost | null> {
    /*
     * Bounded as a whole, not step by step.
     *
     * Each call has its own timeout, but three of them in sequence still add
     * up to something a user waits through before their first message is
     * sent. The session must start on time whatever the studio is doing.
     */
    const budgetMs = input.budgetMs ?? LESSON_SESSION_BOOTSTRAP_BUDGET_MS;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => { expired = true; resolve('timeout'); }, budgetMs);
        timer.unref?.();
    });
    /*
     * A bootstrap that finishes after the deadline still opened a store.
     * Handing back null and walking away would leave that handle open for the
     * life of the process, so the late result is closed here — the earlier
     * comment claimed it closed itself, and nothing did.
     */
    const work = bootstrapLessonSessionHost(input).then((built) => {
        if (built && expired) {
            reportBootstrap('late_closed');
            void built.close().catch(() => undefined);
        }
        return built;
    });
    try {
        const raced = await Promise.race([work, deadline]);
        if (raced === 'timeout') {
            // Eager callers only; production lazy startup reports readiness timeout.
            return reportBootstrap('timeout');
        }
        return raced;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function bootstrapLessonSessionHost(input: {
    accountToken: string | null;
    machineId: string | null;
    sessionId: string;
    /**
     * This provider's own home.
     *
     * Kept for the caller's convenience and deliberately **not** used as the
     * state root; see {@link lessonStateRoot}.
     */
    happyHomeDir: string;
    env?: NodeJS.ProcessEnv;
    announceCandidate?: (envelope: SessionEnvelope) => void;
}): Promise<LessonSessionHost | null> {
    reportBootstrap('start');
    const env = input.env ?? process.env;
    const origin = studioOrigin(env);
    const spawnContext = readCheckpointSpawnContext(env);
    const projectId = spawnContext?.projectId ?? null;
    // Four things, all required. Any one missing and this session has no
    // lesson host — which is a state, not a failure.
    if (!input.accountToken) return reportBootstrap('missing_account');
    if (!input.machineId) return reportBootstrap('missing_machine');
    if (!origin) return reportBootstrap('missing_origin');
    if (!projectId) return reportBootstrap('missing_project');
    /*
     * The daemon's root, whatever this provider's own `HAPPY_HOME_DIR` is.
     *
     * Settings and the spending ledger are the machine's, so a collaborator's
     * relocated home must not fork them. Nothing about the caller changes —
     * the grant, the actor and the permissions are all still this session's.
     */
    const stateRoot = lessonStateRoot(env);
    if (!stateRoot) {
        return reportBootstrap('missing_state_root');
    }
    /*
     * Only the side the daemon named injects.
     *
     * Without the marker CML's native hook is still doing this work, and a
     * host that injected anyway would put the same lessons in twice. The
     * daemon decided before this process started; this is that decision being
     * honoured, not re-made.
     */
    if (readLessonOwner(env) !== 'host') {
        return reportBootstrap('owner_not_host');
    }

    const publicKey = await fetchLessonGrantPublicKey({
        studioBaseUrl: origin, token: input.accountToken, machineId: input.machineId,
    });
    if (!publicKey) return reportBootstrap('public_key_unavailable');

    let verifier;
    try {
        verifier = createLessonGrantVerifier({
            publicKeyBase64: publicKey,
            machineId: input.machineId,
            audience: lessonGrantAudience(origin),
        });
    } catch {
        return reportBootstrap('invalid_public_key');
    }

    // The daemon strips caller environment and forwards only the consumed grant.
    // The server still verifies its user/project/machine and actual session binding.
    const sessionBound = Boolean(env.HAPPY_APLUS_MCP_CALLER_GRANT);
    const sessionAuthority = () => sessionBound
        ? { sessionId: input.sessionId, callerGrant: env.HAPPY_APLUS_MCP_CALLER_GRANT ?? '' }
        : undefined;

    let snapshotUnavailable = false;
    let grantRejected = false;
    const diagnosticVerifier = {
        ...verifier,
        verify: (args: Parameters<typeof verifier.verify>[0]) => {
            const result = verifier.verify(args);
            // Observe the supervisor's existing refusal; do not change it or
            // retain claims, envelopes or failure details in the diagnostic.
            if (!result.ok || result.claims.projectId !== projectId) grantRejected = true;
            return result;
        },
    };
    const supervisor = createLessonHostSupervisor({
        routeVerifier: () => diagnosticVerifier,
        requestSnapshotGrant: async (project) => {
            if (sessionBound) await refreshMcpCallerGrantIfExpiring(input.accountToken!, input.machineId!, {
                projectId: project, sessionId: input.sessionId,
            });
            const grant = await requestLessonSnapshotGrant({
                studioBaseUrl: origin, token: input.accountToken!, machineId: input.machineId!, projectId: project,
                sessionAuthority: sessionAuthority(),
            });
            snapshotUnavailable = !grant;
            return grant;
        },
        machineId: () => input.machineId,
        studioBaseUrl: () => origin,
        studioToken: () => input.accountToken,
        settingsPathFor: (project) => lessonSettingsPath(stateRoot, project),
    });

    let runtime: LessonHostRuntime | null;
    try {
        runtime = await supervisor.ensureOpen(projectId);
    } catch {
        runtime = null;
    }
    if (!runtime) {
        await supervisor.close();
        return reportBootstrap(snapshotUnavailable ? 'snapshot_grant_unavailable'
            : grantRejected ? 'grant_rejected' : 'runtime_unavailable');
    }
    const host = runtime.host();
    const issuer = runtime.issuer();
    if (!host || !issuer) {
        await supervisor.close();
        return reportBootstrap('runtime_incomplete');
    }

    /*
     * The authenticated caller, as the studio signed it.
     *
     * Never derived from the machine id or anything else to hand: that value
     * becomes the CML actor and the gateway's `X-Api-User-Id`, so a
     * constructed one attributes work and spend to a person who never
     * authenticated. If the studio did not name a caller, this session has no
     * lesson host.
     */
    const userId = supervisor.openedUserId(projectId);
    if (!userId) {
        await supervisor.close();
        return reportBootstrap('caller_unavailable');
    }

    const settings = createLessonSettingsStore(lessonSettingsPath(stateRoot, projectId));
    const outcomes = createLessonReviewOutcomeStore(
        lessonReviewOutcomePath(stateRoot, projectId),
    );
    /**
     * Confirms the lease before every piece of host-initiated work.
     *
     * The bootstrap grant authorized one moment. Project, machine or account
     * access can be taken away afterwards and nothing local can see that, so
     * each turn and each review re-checks — and a caller the studio no longer
     * names gets no identity, which stops the work rather than continuing it
     * under a stale one.
     */
    const liveIdentity = async () => {
        const current = await supervisor.authorize(projectId, LESSON_AUTHORIZE_BUDGET_MS);
        if (current !== userId) return null;
        return { projectId, userId, machineId: input.machineId!, sessionId: input.sessionId };
    };

    let built: LessonSessionHost;
    try {
        built = {
            // Read now, before the runner deletes the markers.
            sessionKind: readLessonSessionKind(env),
            turn: createLessonTurnHost({
                host,
                issuer,
                settings,
                identity: liveIdentity,
                // Selection and normal-end ACK are different evidence. Neither
                // asserts that a model read the full body or applied the lesson.
                onOutcome: outcome => logger.debug(
                    `[lesson-host] phase=${outcome === 'delivered' ? 'ack' : 'recall'} outcome=${outcome}`,
                ),
            }),
            review: createLessonReviewWorker({
                host,
                issuer,
                settings,
                budget: new LessonReviewBudget(lessonReviewLedgerPath(stateRoot)),
                identity: liveIdentity,
                onOutcome: (outcome, reason) => {
                    logger.debug(`[lesson-review] ${outcome}${reason ? ` (${reason})` : ''}`);
                    /*
                     * Written where the UI can read it. The worker runs in the
                     * provider process and the snapshot is served by the daemon,
                     * so an in-memory value would leave the UI reporting a state
                     * nothing ever updates.
                     */
                    void outcomes.record(outcome, reason);
                },
                ...(input.announceCandidate
                    ? { onCandidate: (candidate) => input.announceCandidate!(lessonCandidateEnvelope(candidate)) }
                    : {}),
            }),
            close: () => supervisor.close(),
        };
    } catch (error) {
        await supervisor.close();
        throw error;
    }
    reportBootstrap('ready');
    return built;
}


