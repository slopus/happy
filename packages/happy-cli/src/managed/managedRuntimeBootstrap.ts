/**
 * Preparing a managed volume at boot.
 *
 * The restore itself is `CheckpointRestoreExecutor`'s work — it owns the plan,
 * the ledger binding, the safety checkpoint and the exclusion policy, and it
 * handles the content a real workspace has. This is the boundary around it,
 * and each part of that boundary exists because an audit of that pipeline
 * showed it is not provided there:
 *
 *  - **Exclusion across processes.** The executor serializes with an
 *    in-process `Map` keyed by project path. Two daemons on one volume are two
 *    processes, and the window that has to be exclusive spans the restore, the
 *    verification and the publish together — not the restore alone.
 *  - **Durability.** Nothing in that pipeline calls `fsync`. A crash after a
 *    successful restore can leave a completion record standing over files that
 *    never reached the disk, which is precisely the state the record exists to
 *    rule out.
 *  - **Completion.** `partial` is a normal result of that executor, not an
 *    exception. "It returned" is not "it completed", and a record published on
 *    the former describes a workspace with files missing.
 *
 * The record is published last, and only if all three hold.
 *
 * ## What this is not, and must not be read as
 *
 * `CheckpointRestoreExecutor` is an **undo history of working files**, and
 * plan §7 says so: the project's own `.git` is excluded on both sides
 * (`checkpointStore.ts` writes `.git/` into the bare store's `info/exclude`;
 * `checkpointExclusionPolicy.ts` skips the project's `.git` outright), and
 * native provider state, environment and an encrypted remote archive are not
 * in it at all. So nothing here may be cited as satisfying restore-from-backup:
 * laying a checkpoint down does not bring back a repository's metadata,
 * remotes or worktrees, and it does not bring back a machine that was lost.
 *
 * Concretely, what is connectable today is the **empty-created volume** path —
 * a volume this operation created, with no checkpoint to restore from, sealed
 * and recorded as `empty-initialized`. The recovery direction stays incomplete
 * until T13 supplies a real archive adapter for `ManagedRestorePort`; until
 * then this module has a port and no production producer behind it, and saying
 * otherwise would be claiming a placeholder as a feature.
 */
import { createHash } from 'node:crypto';

import { syncTreeToDisk, withManagedProducerLock } from '@/managed/managedRuntimeDurability';

import {
    readManagedRestoreState,
    recordManagedRestoreCompletion,
    type ManagedRestoreState,
    type ManagedVolumeIdentity,
} from '@/managed/managedRestoreState';
import type { ManagedProvisioningDeps } from '@/daemon/managedRuntimeIdentity';

/** The checkpoint to lay down, as the launcher hands it over. */
export type ManagedBootCheckpoint = {
    checkpointId: string;
    plan: unknown;
    binding: unknown;
};

type RestoreEntryOutcome = { outcome?: string };

/**
 * The restore executor, as this producer uses it.
 *
 * Named as a port so the boundary can be exercised without a git store, and
 * kept to the one call the producer makes — a wider surface here would be this
 * module describing an executor it does not own.
 *
 * execute runs inside the producer lock. Do not delegate to the ordinary
 * CheckpointRestoreExecutor for that same store: its pin/snapshot operations
 * reacquire the non-reentrant lock. A production adapter must explicitly
 * support the already-held lock; the current boot path only initializes an
 * empty volume and does not supply such an adapter.
 */
export type ManagedRestorePort = {
    execute: (request: {
        operationId: string;
        plan: unknown;
        confirmed: boolean;
    } & Record<string, unknown>) => Promise<{
        status: 'completed' | 'partial' | 'stale-plan' | 'cancelled';
        entries?: RestoreEntryOutcome[];
    }>;
};

export async function prepareManagedVolume(input: {
    stateDir: string;
    workspace: string;
    volume: ManagedVolumeIdentity;
    /** `null` means there is no checkpoint to restore from — never "this volume is empty". */
    checkpoint: ManagedBootCheckpoint | null;
    restore: ManagedRestorePort;
    /**
     * Where the checkpoint store lives. Its own cross-process lock is what
     * excludes another producer on this volume.
     */
    checkpointRoot?: string;
    /** Overridden only by tests that need to observe the boundary. */
    withProducerLock?: <T>(action: () => Promise<T>) => Promise<T>;
    /** Overridden only by tests; the default flushes files and directories. */
    syncDirectory?: (path: string) => Promise<void>;
    deps: ManagedProvisioningDeps;
}): Promise<ManagedRestoreState> {
    // One lock for the whole producer. Taking it around only the restore would
    // leave the verification and the publish outside it, which is where two
    // producers disagree about what the volume holds.
    const withProducerLock = input.withProducerLock
        ?? ((action) => {
            if (!input.checkpointRoot) {
                throw new Error('managed bootstrap needs a checkpoint root to lock against');
            }
            return withManagedProducerLock(input.checkpointRoot, action);
        });
    // Files and directories both: a directory entry that is durable while the
    // file it names is not is exactly what the record must never claim.
    const syncDirectory = input.syncDirectory ?? (async (path: string) => {
        await syncTreeToDisk(path);
    });

    return withProducerLock(async () => {
        if (input.checkpoint === null) {
            // Nothing to lay down. Whether that is allowed at all is the
            // record's decision: on a volume that was not created by this
            // operation it is refused there.
            return recordManagedRestoreCompletion({
                stateDir: input.stateDir,
                volume: input.volume,
                outcome: { status: 'empty-initialized' },
                deps: input.deps,
            });
        }

        // Asked first, before the restore runs: a volume that already carries a
        // record is a volume holding real work, and restoring over it destroys
        // that. `recordManagedRestoreCompletion` adopts an existing record and
        // refuses a volume this operation did not create, so both answers come
        // from one place rather than being restated here.
        const adopted = adoptExistingRecord(input);
        if (adopted) return adopted;

        const result = await input.restore.execute({
            operationId: input.checkpoint.checkpointId,
            plan: input.checkpoint.plan,
            confirmed: true,
            ...(input.checkpoint.binding as Record<string, unknown>),
        });
        if (result.status !== 'completed') {
            throw new Error(`managed restore did not complete: ${result.status}`);
        }
        const failed = (result.entries ?? []).filter((entry) => (
            entry.outcome === 'failed' || entry.outcome === 'conflict'
        ));
        if (failed.length > 0) {
            // A completed restore with failed entries is a workspace missing
            // files nobody will notice are missing.
            throw new Error(`managed restore left ${failed.length} entr${failed.length === 1 ? 'y' : 'ies'} unapplied`);
        }

        // Before the record, never after: the record is the claim that these
        // files are there.
        await syncDirectory(input.workspace);

        return recordManagedRestoreCompletion({
            stateDir: input.stateDir,
            volume: input.volume,
            outcome: {
                status: 'restored',
                checkpointId: input.checkpoint.checkpointId,
                manifestDigest: digestOfPlan(input.checkpoint),
            },
            deps: input.deps,
        });
    });
}

/**
 * Returns the existing record when the volume was already prepared.
 *
 * Written as a probe rather than a read so the "belongs to another volume" and
 * "not created by this operation" rules stay in one place: it asks the record
 * writer, which refuses in exactly those cases.
 */
function adoptExistingRecord(input: {
    stateDir: string;
    volume: ManagedVolumeIdentity;
    deps: ManagedProvisioningDeps;
}): ManagedRestoreState | null {
    const state = readManagedRestoreState({
        stateDir: input.stateDir,
        volume: input.volume,
        deps: input.deps,
    });
    if (state.status === 'restored' || state.status === 'empty-initialized') return state;
    if (state.status === 'failed') {
        throw new Error('managed restore record exists and cannot be trusted');
    }
    if (!input.volume.createdByThisOperation) {
        throw new Error('managed restore refused: volume was not created by this operation');
    }
    return null;
}

/** A stable digest of the plan that was applied, for the completion record. */
function digestOfPlan(checkpoint: ManagedBootCheckpoint): string {
    return createHash('sha256')
        .update(JSON.stringify({ id: checkpoint.checkpointId, plan: checkpoint.plan }))
        .digest('hex');
}
