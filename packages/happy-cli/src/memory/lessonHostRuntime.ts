/**
 * Assembles the lesson host for the daemon and answers `lesson-host-v1`.
 *
 * Everything here fails closed and fails *typed*. Four things must all be
 * present before a single lesson operation can run, and each absence has its
 * own answer so a user is told which one to fix:
 *
 *  - a studio base URL, which also fixes the grant audience;
 *  - the studio's verification key, so a grant can be checked;
 *  - this machine's id, so a grant for another machine is refused;
 *  - an installed CML build exposing the stable lesson-host entry point.
 *
 * None of these is read from anything a spawn RPC caller supplied. The daemon's
 * own configuration and the studio's signed response are the only inputs.
 */
import { logger } from '@/ui/logger';

import { openLessonHost, type LessonHostHandle } from './cmlLessonHost';
import { createLessonBindingIssuer, type LessonBindingIssuer } from './lessonBindingIssuer';
import { createLessonGrantVerifier, lessonGrantAudience, type LessonGrantVerifier } from './lessonGrantVerifier';
import { createLessonHostRpc, type LessonHostResponse } from './lessonHostRpc';
import { createLessonSettingsStore } from './lessonSettingsStore';

export const LESSON_HOST_RPC_METHOD = 'lesson-host-v1';

/**
 * Fetches the studio's Ed25519 verification key.
 *
 * Authenticated, even though the key itself is public. The studio's HTTP gate
 * protects `/api/*` wholesale, so an unauthenticated read would simply 401 and
 * the feature would never start — and adding this route to the public
 * allowlist to avoid that would widen the gate for a problem that does not
 * need it. The daemon already holds an account bearer and already presents it
 * this way for its MCP config (`aplus/fetchAplusMcpServers.ts`), so the same
 * headers are reused rather than a new anonymous surface invented.
 */
export async function fetchLessonGrantPublicKey(input: {
    studioBaseUrl: string;
    /** The daemon's account bearer. Without one there is no request to make. */
    token: string;
    machineId: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}): Promise<string | null> {
    if (!input.token || !input.machineId) return null;
    const url = new URL('/api/lesson-grant/public-key', input.studioBaseUrl);
    /*
     * The origin is the daemon's configured studio, and it must be one a
     * bearer may be sent to. An http origin is accepted only for an explicit
     * loopback dev host; anything else would put an account token on the wire
     * in the clear.
     */
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 5_000);
    timer.unref?.();
    try {
        const response = await (input.fetchImpl ?? fetch)(url.toString(), {
            method: 'GET',
            redirect: 'error',
            signal: controller.signal,
            headers: {
                Authorization: `Bearer ${input.token}`,
                'X-Aplus-Machine-Id': input.machineId,
            },
        });
        if (!response.ok) return null;
        const body = await response.json() as { algorithm?: unknown; publicKey?: unknown };
        // An unexpected algorithm is refused rather than assumed: this verifier
        // only knows how to check Ed25519.
        if (body.algorithm !== 'ed25519') return null;
        return typeof body.publicKey === 'string' && body.publicKey.length > 0 ? body.publicKey : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Asks the studio for a read-only snapshot grant.
 *
 * Authenticated as the daemon's own account, exactly like the key fetch. The
 * studio applies its own gates and signs the project's workspace; a refusal is
 * null and the project simply does not open.
 */
export async function requestLessonSnapshotGrant(input: {
    studioBaseUrl: string;
    token: string;
    machineId: string;
    projectId: string;
    sessionAuthority?: { sessionId: string; callerGrant: string };
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}): Promise<string | null> {
    if (!input.token || !input.machineId || !input.projectId) return null;
    const url = new URL(
        `/api/projects/${encodeURIComponent(input.projectId)}/${input.sessionAuthority ? 'lesson-host/snapshot' : 'lesson-grant'}`, input.studioBaseUrl,
    );
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 5_000);
    timer.unref?.();
    try {
        const response = await (input.fetchImpl ?? fetch)(url.toString(), {
            method: 'POST',
            redirect: 'error',
            signal: controller.signal,
            headers: {
                Authorization: `Bearer ${input.token}`,
                'X-Aplus-Machine-Id': input.machineId,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                machineId: input.machineId,
                ...input.sessionAuthority,
                request: {
                    version: 1, projectId: input.projectId,
                    requestId: `open:${input.projectId}`, operation: 'snapshot',
                },
            }),
        });
        if (!response.ok) {
            // Status and route kind only: the body can echo the caller grant.
            logger.debug(`[lesson-host] snapshot grant refused ${response.status} (${input.sessionAuthority ? 'session' : 'account'})`);
            return null;
        }
        const body = await response.json() as { envelope?: unknown };
        return typeof body.envelope === 'string' && body.envelope.length > 0 && body.envelope.length <= 32_768
            ? body.envelope
            : null;
    } catch {
        logger.debug(`[lesson-host] snapshot grant request ${controller.signal.aborted ? 'timed out' : 'failed'}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export interface LessonHostRuntime {
    handle(params: unknown): Promise<LessonHostResponse>;
    /** The live handle, for the turn host and the review worker. */
    host(): LessonHostHandle | null;
    /** The only way to obtain a binding CML will act on. */
    issuer(): LessonBindingIssuer | null;
    generation(): Promise<number>;
    close(): Promise<void>;
}

export async function createLessonHostRuntime(input: {
    workspaceDir: string;
    machineId: string | null;
    studioBaseUrl: string | null;
    /** The daemon's account bearer; absent for a managed runtime, which has none. */
    studioToken: string | null;
    /**
     * The verifier this runtime should use, when the caller already built one.
     *
     * The supervisor builds one to route requests, and without this the
     * runtime fetched the same public key a second time — one extra
     * authenticated round trip per project open, on the path a first turn
     * waits on. Absent, the runtime fetches its own.
     */
    verifier?: LessonGrantVerifier | null;
    /**
     * The studio project this workspace belongs to, as the daemon resolved it.
     *
     * Pinned so a grant legitimately minted for another project on the same
     * machine cannot be pointed at this store. Null leaves the runtime
     * unpinned, and the issuer then trusts only the store hash.
     */
    projectId: string | null;
    settingsPath: string;
    /** Reads the worker's last recorded outcome; absent means unknown. */
    reviewOutcome?: () => Promise<string>;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
}): Promise<LessonHostRuntime> {
    const settings = createLessonSettingsStore(input.settingsPath);
    /*
     * The fence is the settings revision, read fresh every time.
     *
     * A process-local counter would restart at 1, so a candidate written at
     * revision 5 could never be approved after a restart — and could match
     * again by coincidence after a few writes. The revision is durable, and
     * because it is read from the file, another window turning recall off
     * fences work in this process too.
     */
    const generation = async () => (await settings.read()).revision;
    /*
     * `unknown` until something says otherwise.
     *
     * `idle` was a claim this process could not support: the review worker
     * runs elsewhere, so "nothing has run" and "we cannot tell" look the same
     * from here, and reporting the second as the first tells a user the
     * feature is fine when it may not be.
     */
    let reviewOutcome = 'unknown';
    let verifier: LessonGrantVerifier | null = null;
    let handle: LessonHostHandle | null = null;
    let closed = false;

    /*
     * Built before the store is opened because CML needs its `verifyBinding`
     * at open time. `projectHash` therefore reads back from `handle`, which is
     * assigned a moment later — and until it is, the issuer refuses, which is
     * the correct answer for "the store is not open yet".
     */
    const issuer: LessonBindingIssuer = createLessonBindingIssuer({
        projectHash: () => handle?.projectHash ?? null,
        projectId: input.projectId,
        generation,
        closed: () => closed,
    });

    if (input.verifier) {
        verifier = input.verifier;
    } else if (input.studioBaseUrl && input.machineId && input.studioToken) {
        const publicKey = await fetchLessonGrantPublicKey({
            studioBaseUrl: input.studioBaseUrl,
            token: input.studioToken,
            machineId: input.machineId,
            fetchImpl: input.fetchImpl,
        });
        if (publicKey) {
            try {
                verifier = createLessonGrantVerifier({
                    publicKeyBase64: publicKey,
                    machineId: input.machineId,
                    // Bound to the origin the key came from, so a grant minted by
                    // another deployment of this protocol cannot be used here.
                    audience: lessonGrantAudience(input.studioBaseUrl),
                });
            } catch (error) {
                logger.debug(`[lesson-host] verification key unusable: ${(error as Error).message}`);
            }
        } else {
            reviewOutcome = 'disabled';
            logger.debug('[lesson-host] studio has no lesson grant key; lesson host disabled');
        }
    }

    const opened = await openLessonHost({
        workspaceDir: input.workspaceDir,
        env: input.env,
        /*
         * CML calls this at every entry and again immediately before each
         * write, and this is where that call lands. It resolves only handles
         * the issuer minted for an already-verified identity, and re-checks
         * release, expiry, closure, generation and project on every call.
         *
         * An earlier version returned its argument. That satisfied the type and
         * defeated the whole contract: any object shaped like a binding became
         * an identity with whatever capabilities it claimed.
         */
        verifyBinding: issuer.verifier(),
    });
    if (opened.ok) {
        handle = opened.handle;
    } else {
        reviewOutcome = 'unsupported';
        logger.debug(`[lesson-host] CML lesson host unavailable: ${opened.detail}`);
    }

    const rpc = createLessonHostRpc({
        verifier,
        issuer,
        host: handle,
        settings,
        generation,
        // The recorded outcome wins; the local value only carries the reasons
        // this runtime knows first-hand (no key, no store).
        reviewOutcome: async () => (reviewOutcome === 'unknown' && input.reviewOutcome
            ? input.reviewOutcome()
            : reviewOutcome),
    });

    return {
        handle: rpc,
        host: () => handle,
        issuer: () => (handle ? issuer : null),
        generation,
        close: async () => {
            // Flipped first: every binding stops resolving before the store
            // goes away, so nothing in flight can act on a closing database.
            closed = true;
            await handle?.close();
        },
    };
}
