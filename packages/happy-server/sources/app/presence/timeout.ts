import { db } from "@/storage/db";
import { delay } from "@/utils/delay";
import { forever } from "@/utils/forever";
import { shutdownSignal } from "@/utils/shutdown";
import { buildMachineActivityEphemeral, buildSessionActivityEphemeral, eventRouter } from "@/app/events/eventRouter";

/**
 * Starts the background timeout sweep that marks stale sessions and machines as inactive.
 *
 * ## Multi-Process Safety (Idempotent by Design)
 *
 * This function is safe to run on every server process simultaneously. When multiple
 * processes run the sweep in parallel, correctness is guaranteed:
 *
 * 1. **Atomic conditional update prevents double-marking.**
 *    `updateManyAndReturn({ where: { id, active: true }, data: { active: false } })`
 *    is an atomic conditional update at the database level. If two processes race on the
 *    same session/machine, exactly one succeeds (returns the updated row) and the other
 *    gets an empty result set. The losing process skips the ephemeral emit entirely
 *    (via the `if (updated.length === 0) continue` guard).
 *
 * 2. **Ephemeral events are delivered to user-scoped clients across all processes.**
 *    After the EventRouter backplane refactor (Task 2), `emitEphemeral()` publishes to
 *    the `hp:user:{userId}:ephemeral` backplane channel. Every process subscribed for
 *    that user receives the payload and delivers it to its locally-connected user-scoped
 *    sockets. This means a timeout detected on process A correctly notifies user-scoped
 *    clients on processes B, C, etc.
 *
 * 3. **Duplicate ephemeral events are harmless on the client.**
 *    In the rare case where both processes emit before the DB update is visible (possible
 *    under snapshot isolation), clients handle duplicate `{ type: 'activity', active: false }`
 *    events idempotently:
 *    - The mobile app's `ActivityUpdateAccumulator` deduplicates same-state updates via
 *      its `isSignificantChange` check (same active + same thinking = not significant,
 *      absorbed by debounce).
 *    - The `flushActivityUpdates` handler merges state via `applySessions()`, which is a
 *      simple state overwrite — setting `active: false` twice produces the same UI state.
 *    - Machine activity updates go through `applyMachines()`, also a state merge — setting
 *      `active: false` twice is identical.
 *
 * ## Future Optimization: Leader Election
 *
 * Running duplicate sweeps on N processes wastes ~N× the DB queries (findMany for stale
 * sessions + machines). This is operationally tolerable at low replica counts (2-4) since
 * the queries are lightweight index scans, but at higher scale a leader election mechanism
 * would reduce the waste to 1× regardless of replica count. Options:
 * - PostgreSQL advisory locks: `SELECT pg_try_advisory_lock(hash)` — zero external deps
 * - Redis `SET NX PX`: `SET hp:leader:timeout {processId} NX PX 90000` — leverages existing Redis
 *
 * See `docs/plans/multiprocess-architecture.md` for the full design rationale.
 */
export function startTimeout() {
    forever('session-timeout', async () => {
        while (true) {
            // Find timed out sessions
            const sessions = await db.session.findMany({
                where: {
                    active: true,
                    lastActiveAt: {
                        lte: new Date(Date.now() - 1000 * 60 * 10) // 10 minutes
                    }
                }
            });
            for (const session of sessions) {
                // Atomic conditional update: only one process can transition active → false.
                // If another process already did it, `updated` is empty and we skip the emit.
                const updated = await db.session.updateManyAndReturn({
                    where: { id: session.id, active: true },
                    data: { active: false }
                });
                if (updated.length === 0) {
                    continue;
                }
                // Ephemeral event reaches user-scoped clients on ALL processes via the backplane.
                // Recipient filter 'user-scoped-only' ensures only user-scoped sockets get it
                // (not session-scoped or machine-scoped connections).
                eventRouter.emitEphemeral({
                    userId: session.accountId,
                    payload: buildSessionActivityEphemeral(session.id, false, updated[0].lastActiveAt.getTime(), false),
                    recipientFilter: { type: 'user-scoped-only' }
                });
            }

            // Find timed out machines
            const machines = await db.machine.findMany({
                where: {
                    active: true,
                    lastActiveAt: {
                        lte: new Date(Date.now() - 1000 * 60 * 10) // 10 minutes
                    }
                }
            });
            for (const machine of machines) {
                // Same atomic conditional update pattern as sessions above.
                const updated = await db.machine.updateManyAndReturn({
                    where: { id: machine.id, active: true },
                    data: { active: false }
                });
                if (updated.length === 0) {
                    continue;
                }
                // Ephemeral event reaches user-scoped clients on ALL processes via the backplane.
                eventRouter.emitEphemeral({
                    userId: machine.accountId,
                    payload: buildMachineActivityEphemeral(machine.id, false, updated[0].lastActiveAt.getTime()),
                    recipientFilter: { type: 'user-scoped-only' }
                });
            }

            // Wait for 1 minute
            await delay(1000 * 60, shutdownSignal);
        }
    });
}