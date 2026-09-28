/**
 * One lesson host per project, opened on demand and closed with the daemon.
 *
 * Which store opens is decided by the **signed grant**, not by the request and
 * not by anything the daemon inferred from a spawn.
 *
 * That distinction is the whole point. The MCP caller-grant envelope the
 * daemon already consumes signs a project and a machine but never a directory,
 * so a spawn holding a perfectly valid grant for project A can name project
 * B's directory. Deriving the workspace from that spawn would let A's
 * authority open B's memory. The studio signs `workspaceDir` off the
 * authorized project row, and this supervisor opens that path and no other.
 *
 * A grant that names a project already open under a different path is refused
 * rather than reopened: two paths for one project id means something upstream
 * is wrong, and taking the newer one would move that project's memory.
 *
 * Opens are de-duplicated by an in-flight promise: two RPCs racing on a cold
 * project must not each open a SQLite handle on the same file.
 */
import { logger } from '@/ui/logger';

import { createLessonHostRuntime, type LessonHostRuntime } from './lessonHostRuntime';
import { createLessonGrantVerifier, type LessonGrantVerifier } from './lessonGrantVerifier';
import type { LessonHostResponse } from './lessonHostRpc';

export interface LessonHostSupervisorOptions {
    /**
     * Reads the signed workspace out of an envelope, without consuming it.
     *
     * The same verifier the runtime uses; routing must not burn a single-use
     * mutation grant before the request that needs it runs.
     */
    routeVerifier: () => LessonGrantVerifier | null;
    /** Retry a missing startup key, from the daemon-owned Studio origin only. */
    loadRouteVerifier?: () => Promise<LessonGrantVerifier | null>;
    machineId: () => string | null;
    /** Daemon-owned studio origin; never a value from a request. */
    studioBaseUrl: () => string | null;
    /** The daemon's account bearer. */
    studioToken: () => string | null;
    /** Where per-project settings live; one file per project. */
    settingsPathFor(projectId: string): string;
    /**
     * The last review outcome the worker recorded, or `'unknown'`.
     *
     * Read rather than held: the worker runs in a provider process and this
     * supervisor serves the UI from the daemon, so an in-memory value here
     * would report a state nothing ever updates.
     */
    reviewOutcomeFor?(projectId: string): Promise<string>;
    /**
     * Asks the studio to mint a read-only snapshot grant for a project.
     *
     * This is how a project opens without a person clicking first. The daemon
     * authenticates as itself, the studio applies the same gates it applies to
     * the UI — project access, machine access, manage rights — and signs the
     * project's own `workspaceDir`. The daemon still never chooses a path; it
     * just asks a question it is entitled to ask.
     */
    requestSnapshotGrant?(projectId: string): Promise<string | null>;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
}

export interface LessonHostSupervisor {
    handle(params: unknown): Promise<LessonHostResponse>;
    /**
     * Opens a project for host-initiated work (a turn, a review).
     *
     * Those callers hold no grant of their own, so one is requested from the
     * studio. The workspace still comes from the signature — the daemon is
     * asking, not asserting.
     */
    ensureOpen(projectId: string): Promise<LessonHostRuntime | null>;
    /**
     * For the turn host and the review worker.
     *
     * Only an **already open** project is returned. Those callers hold no
     * grant, so they cannot name a workspace, and inventing one from the
     * session's directory would reintroduce exactly the hole the signed claim
     * closes. A project nobody has opened through a grant yet is simply not
     * available to them — safe, and knowingly incomplete.
     */
    openedRuntimeFor(projectId: string): LessonHostRuntime | null;
    /**
     * The authenticated caller the studio named when this project was opened.
     *
     * Read back rather than derived: a host that invents a user id attributes
     * work — and gateway spend — to somebody who never authenticated.
     */
    openedUserId(projectId: string): string | null;
    /**
     * Confirms this project is still authorized, refreshing if the lease aged
     * out, and returns the caller the studio names *now*.
     *
     * The initial grant authorized one moment. Access to a project, a machine
     * or an account can be taken away afterwards, and nothing local can
     * observe that — so the lease carries the verified grant's own expiry and
     * is renewed by asking the studio again, never extended here.
     */
    authorize(projectId: string, budgetMs: number): Promise<string | null>;
    close(): Promise<void>;
}

/**
 * The route a request may take: its project and the workspace signed for it.
 *
 * Read from the envelope's claims, never from the request body. A body field
 * is a caller's assertion; these two came from the studio's signature over the
 * authorized project row.
 */
function routeFor(
    params: unknown,
    verifier: LessonGrantVerifier | null,
): { projectId: string; workspaceDir: string; userId: string; expiresAt: number } | null {
    if (!verifier || !params || typeof params !== 'object' || Array.isArray(params)) return null;
    const { grantEnvelope, ...request } = params as Record<string, unknown>;
    const verified = verifier.verify({ envelope: grantEnvelope, request });
    return verified.ok
        ? {
            projectId: verified.claims.projectId,
            workspaceDir: verified.claims.workspaceDir,
            userId: verified.claims.userId,
            expiresAt: verified.claims.expiresAt,
        }
        : null;
}

export function createLessonHostSupervisor(options: LessonHostSupervisorOptions): LessonHostSupervisor {
    const runtimes = new Map<string, {
        runtime: LessonHostRuntime;
        workspaceDir: string;
        userId: string;
        /** Epoch ms from the verified grant. Never advanced locally. */
        leaseExpiresAt: number;
    }>();
    /** One refresh in flight per project; a turn must not start a second. */
    const refreshing = new Map<string, Promise<string | null>>();
    const opening = new Map<string, { workspaceDir: string; promise: Promise<LessonHostRuntime | null> }>();
    let closed = false;
    let recoveredVerifier: LessonGrantVerifier | null = null;
    let loadingVerifier: Promise<void> | null = null;
    let retryVerifierAt = 0;
    const verifier = () => options.routeVerifier() ?? recoveredVerifier;
    async function refreshVerifier(): Promise<void> {
        if (closed || verifier() || !options.loadRouteVerifier) return;
        if (loadingVerifier) return loadingVerifier;
        if (Date.now() < retryVerifierAt) return;
        loadingVerifier = options.loadRouteVerifier().then((loaded) => {
            if (!closed) recoveredVerifier = loaded;
        }).catch(() => undefined).finally(() => {
            retryVerifierAt = Date.now() + 5_000;
            loadingVerifier = null;
        });
        return loadingVerifier;
    }


    async function open(
        projectId: string,
        workspaceDir: string,
        userId: string,
        leaseExpiresAt: number,
    ): Promise<LessonHostRuntime | null> {
        const existing = runtimes.get(projectId);
        if (existing) {
            // One project, one path. A second path for the same id is a
            // contradiction, not a relocation.
            if (existing.workspaceDir !== workspaceDir) {
                logger.debug('[lesson-host] refused: project already open at another path');
                return null;
            }
            return existing.runtime;
        }
        const inFlight = opening.get(projectId);
        if (inFlight) {
            // The same path check the resolved case gets. Returning the
            // in-flight promise unconditionally would let a second request
            // naming a different workspace ride on the first one's open and
            // skip the check entirely.
            if (inFlight.workspaceDir !== workspaceDir) return null;
            return inFlight.promise;
        }

        const promise = (async () => {
            const runtime = await createLessonHostRuntime({
                workspaceDir,
                projectId,
                machineId: options.machineId(),
                studioBaseUrl: options.studioBaseUrl(),
                studioToken: options.studioToken(),
                settingsPath: options.settingsPathFor(projectId),
                // Reuses the routing verifier rather than fetching the same
                // public key again on the path a first turn waits on.
                verifier: verifier(),
                ...(options.reviewOutcomeFor
                    ? { reviewOutcome: () => options.reviewOutcomeFor!(projectId) }
                    : {}),
                env: options.env,
                fetchImpl: options.fetchImpl,
            });
            // The daemon shut down while this was opening.
            if (closed) {
                await runtime.close();
                return null;
            }
            runtimes.set(projectId, { runtime, workspaceDir, userId, leaseExpiresAt });
            return runtime;
        })().catch(() => {
            // Classification only: a raw error quotes paths and store details.
            logger.debug('[lesson-host] store open failed');
            return null;
        }).finally(() => {
            opening.delete(projectId);
        });
        opening.set(projectId, { workspaceDir, promise });
        return promise;
    }

    return {
        async handle(params) {
            if (closed) return { ok: false, reason: 'unsupported' };
            await refreshVerifier();
            if (closed) return { ok: false, reason: 'unsupported' };
            const route = routeFor(params, verifier());
            /*
             * No verifiable route means no store. `permission_denied` rather
             * than `unsupported`: the envelope is what names the project and
             * the path, so a request without a good one was never entitled to
             * either. The runtime verifies the same envelope again — this read
             * only decides which store the request reaches.
             */
            if (!route) return { ok: false, reason: 'permission_denied' };
            /*
             * A UI request carries a fresh grant, so its own expiry renews the
             * lease — but only when it is the *same* caller and the same
             * workspace. A second person with perfectly valid access to the
             * project would otherwise keep the first person's host lease alive
             * long after their own access was withdrawn. The UI request itself
             * is still served; only the host identity's lease is separate.
             */
            const existing = runtimes.get(route.projectId);
            if (existing
                && existing.userId === route.userId
                && existing.workspaceDir === route.workspaceDir) {
                existing.leaseExpiresAt = Math.max(existing.leaseExpiresAt, route.expiresAt);
            }
            const runtime = await open(
                route.projectId, route.workspaceDir, route.userId, route.expiresAt,
            );
            if (!runtime) return { ok: false, reason: 'unsupported' };
            return runtime.handle(params);
        },
        openedRuntimeFor: (projectId) => (closed ? null : runtimes.get(projectId)?.runtime ?? null),
        openedUserId: (projectId) => (closed ? null : runtimes.get(projectId)?.userId ?? null),
        async authorize(projectId, budgetMs) {
            if (closed) return null;
            const entry = runtimes.get(projectId);
            if (!entry) return null;
            const now = Date.now();
            if (now < entry.leaseExpiresAt) return entry.userId;
            /*
             * Expired. The only way to learn whether access still exists is to
             * ask the studio for a new grant; extending the lease here would
             * be this host deciding its own authority, which is the thing the
             * signature exists to prevent.
             */
            if (!options.requestSnapshotGrant) return null;
            const refresh = refreshing.get(projectId) ?? (async (): Promise<string | null> => {
                const startedAt = Date.now();
                // Reason codes only; never the envelope or its claims.
                const failed = (reason: string) => {
                    logger.debug(`[lesson-host] lease renewal failed (${reason}) ${Date.now() - startedAt}ms`);
                    return null;
                };
                const envelope = await options.requestSnapshotGrant!(projectId).catch(() => null);
                const currentVerifier = verifier();
                if (!envelope) return failed('no-grant');
                if (!currentVerifier) return failed('no-verifier');
                const verified = currentVerifier.verify({
                    envelope,
                    request: {
                        version: 1, projectId, requestId: `open:${projectId}`, operation: 'snapshot',
                    },
                });
                if (!verified.ok || verified.claims.projectId !== projectId) return failed('unverified');
                const live = runtimes.get(projectId);
                if (!live) return failed('closed');
                /*
                 * A revoked caller gets a different answer — or none. Either
                 * way the store stays open for the UI, and host-initiated work
                 * stops until the studio names this caller again.
                 */
                if (verified.claims.userId !== live.userId) return failed('caller-changed');
                if (verified.claims.workspaceDir !== live.workspaceDir) return failed('workspace-changed');
                live.leaseExpiresAt = verified.claims.expiresAt;
                logger.debug(`[lesson-host] lease renewed ${Date.now() - startedAt}ms`);
                return live.userId;
            })().finally(() => refreshing.delete(projectId));
            refreshing.set(projectId, refresh);
            /*
             * Every caller races the same deadline, joiners included. Handing
             * a joiner the shared promise directly would let it wait as long
             * as the first caller's request takes, which is exactly the
             * unbounded wait the budget exists to prevent.
             */
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                return await Promise.race([
                    refresh,
                    new Promise<null>((resolve) => {
                        timer = setTimeout(() => {
                            logger.debug(`[lesson-host] lease renewal exceeded the ${budgetMs}ms authorize budget`);
                            resolve(null);
                        }, budgetMs);
                        timer.unref?.();
                    }),
                ]);
            } finally {
                if (timer) clearTimeout(timer);
            }
        },
        async ensureOpen(projectId) {
            if (closed) return null;
            await refreshVerifier();
            if (closed) return null;
            const already = runtimes.get(projectId);
            if (already) return already.runtime;
            if (!options.requestSnapshotGrant) return null;
            const envelope = await options.requestSnapshotGrant(projectId).catch(() => null);
            if (!envelope) return null;
            /*
             * Verified here, not trusted because the daemon asked for it. The
             * studio is the only thing that decides which path this project
             * may open, and the check is the same one an RPC gets.
             */
            const currentVerifier = verifier();
            if (!currentVerifier) return null;
            const verified = currentVerifier.verify({
                envelope,
                request: { version: 1, projectId, requestId: `open:${projectId}`, operation: 'snapshot' },
            });
            if (!verified.ok || verified.claims.projectId !== projectId) return null;
            return open(
                projectId,
                verified.claims.workspaceDir,
                verified.claims.userId,
                verified.claims.expiresAt,
            );
        },
        async close() {
            closed = true;
            const live = [...runtimes.values()];
            runtimes.clear();
            await Promise.all(live.map(({ runtime }) => runtime.close().catch(() => {})));
        },
    };
}
