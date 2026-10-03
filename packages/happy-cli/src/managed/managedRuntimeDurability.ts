/**
 * The durability and exclusion a boot producer needs, and the restore pipeline
 * does not provide.
 *
 * An audit of `checkpointRestore.ts`, `checkpointStore.ts` and
 * `checkpointTurnApply.ts` found no `fsync` at all, and a restore
 * serialization that is an in-process `Map` keyed by project path. Neither is
 * a defect there — a restore driven by a user does not publish a durable claim
 * about a volume, and does not race a second daemon. A boot producer does
 * both.
 */
import { constants, promises as fs } from 'node:fs';
import { openSync, closeSync, fstatSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

import { withCheckpointStoreLock } from '@/checkpoint/checkpointStoreLock';

/**
 * Excludes every other producer on this volume, across processes.
 *
 * The checkpoint store's own lock, reused rather than reinvented: it is a
 * `git update-ref` with an empty old value, which is atomic and visible to
 * every process on the machine. The executor's in-process queue is not — two
 * daemons on one volume are two processes and would not see each other's
 * queue at all.
 *
 * This lock is not reentrant. Its action must not acquire the same checkpoint
 * store lock again (including ordinary CheckpointRestoreExecutor, whose pin
 * and snapshot operations acquire it). A boot restore adapter must honor the
 * already-held producer lock before checkpoint restore is wired here.
 */
export function withManagedProducerLock<T>(
    checkpointRoot: string,
    action: () => Promise<T>,
): Promise<T> {
    return withCheckpointStoreLock(checkpointRoot, action);
}

export type SyncedTree = { files: string[]; directories: string[] };

/**
 * Flushes a restored tree to the disk, files and directories both.
 *
 * A directory `fsync` makes the *entry* durable and says nothing about the
 * bytes in the file; a file `fsync` does the reverse. The record published
 * afterwards claims both, so both are flushed — files first, then the
 * directories that name them, deepest first.
 *
 * Symlinks are not followed. Following one would reach outside the volume this
 * producer is preparing, and flushing something out there is touching a path
 * that is none of its business.
 */
export async function syncTreeToDisk(root: string): Promise<SyncedTree> {
    const files: string[] = [];
    const directories: string[] = [];

    async function walk(dir: string): Promise<void> {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = join(dir, entry.name);
            // `readdir` reports the entry itself, so a symlink is reported as
            // a symlink rather than as whatever it points at — neither branch
            // below takes it, and nothing outside the tree is ever opened.
            if (entry.isDirectory()) {
                await walk(full);
                continue;
            }
            if (!entry.isFile()) continue;
            const handle = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                await handle.sync();
                files.push(full);
            } finally {
                await handle.close();
            }
        }
        // After its contents: a directory entry that is durable while the file
        // it names is not is the state this exists to rule out.
        const handle = await fs.open(dir, constants.O_RDONLY);
        try {
            await handle.sync();
            directories.push(dir);
        } finally {
            await handle.close();
        }
    }

    await walk(root);
    return { files, directories };
}

/**
 * The device id the kernel would report for a `major:minor` pair.
 *
 * `mountinfo` reports two numbers and `stat` reports one; comparing them means
 * putting both in the same space, and the encoding is the kernel's own.
 */
export function deviceIdFromMajorMinor(value: string): number | null {
    const match = /^(\d+):(\d+)$/.exec(value.trim());
    if (!match) return null;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return null;
    return ((major & 0xfff) << 8) | (minor & 0xff)
        | ((major & ~0xfff) * 0x100000000) | ((minor & ~0xff) << 12);
}

export type DeviceCheck =
    | { ok: true }
    | { ok: false; reason: 'root-not-mounted' | 'root-on-other-device' };

/**
 * Confirms the path is on the expected device, from the descriptor it opens.
 *
 * A lexical check compares strings and a `stat` on a path checks whatever the
 * path resolves to at that moment. Opening with `O_NOFOLLOW` and reading the
 * device off *that* descriptor is the thing a symlink cannot redirect: the
 * answer is about the object the producer would actually use.
 */
export function verifyOpenPathDevice(path: string, expectedDevice: number): DeviceCheck {
    let fd: number;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
        // ELOOP for a symlink, ENOENT for nothing there: in both cases the
        // project root is not something this runtime can stand on.
        return { ok: false, reason: 'root-not-mounted' };
    }
    try {
        const stat = fstatSync(fd);
        if (Number(stat.dev) !== expectedDevice) {
            return { ok: false, reason: 'root-on-other-device' };
        }
        return { ok: true };
    } finally {
        closeSync(fd);
    }
}

/** Whether a path is a symlink, without following it. */
export function isSymbolicLink(path: string): boolean {
    try {
        return lstatSync(path).isSymbolicLink();
    } catch {
        return false;
    }
}
